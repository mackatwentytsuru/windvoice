# WindVoice 同梱: ローカル STT (engine = local) のときに WindVoice が起動する。
"""手元の聞き取りサーバ(sherpa-onnx + NVIDIA Parakeet 日本語版, CPU)。

標準ライブラリの http.server だけで待ち受ける。127.0.0.1 以外では待たない。
起動時にモデルを1回だけ読み込み、読み込みが終わってから待ち受けを始める
(= ポートが開いた時点で必ず使える)。

  POST /transcribe   本文 = WAV(16kHz・モノラル・PCM16 が基本。他の周波数でも sherpa が内部で合わせる)
                     -> {"text": "...", "ms": 認識にかかった時間(ミリ秒)}
  GET  /health       -> {"ok": true, "model": "...", "threads": N, "load_ms": N}

使い方:
  python sherpa_server.py --model-dir <モデルのフォルダ> --port 5312 --threads 4 [--parent-pid PID]

--parent-pid を付けると、その親プロセスが消えたら自分も終了する(WindVoice が強制終了されても残らない)。
"""
import argparse
import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 32 * 1024 * 1024  # 32MB(約16分)。これより大きい要求は拒否する


def log(*a):
    print('[sherpa]', *a, file=sys.stderr, flush=True)


def load_recognizer(model_dir, threads):
    import sherpa_onnx  # 遅延 import: --help が速く、未導入のときはここで明確に落ちる
    model = os.path.join(model_dir, 'model.int8.onnx')
    tokens = os.path.join(model_dir, 'tokens.txt')
    for p in (model, tokens):
        if not os.path.isfile(p):
            raise FileNotFoundError(p)
    return sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
        model=model, tokens=tokens, num_threads=threads, provider='cpu')


def wav_to_float(body):
    """WAV バイト列 -> (float32 の numpy 配列, サンプル周波数)。PCM16 のみ受ける(多チャンネルは平均してモノラルに)。"""
    import numpy as np
    try:
        with wave.open(io.BytesIO(body), 'rb') as w:
            ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(n)
    except (wave.Error, EOFError) as e:
        raise ValueError('WAV として読めません: %s' % e)
    if width != 2:
        raise ValueError('PCM16 のみ対応です(sampwidth=%d)' % width)
    x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, rate


class Handler(BaseHTTPRequestHandler):
    server_version = 'sherpa-stt/1'

    def log_message(self, fmt, *args):  # 標準のアクセスログは出さない
        pass

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split('?')[0] == '/health':
            s = self.server.state
            self._json(200, {'ok': True, 'model': s['model'], 'threads': s['threads'], 'load_ms': s['load_ms']})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path.split('?')[0] != '/transcribe':
            return self._json(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            return self._json(400, {'error': 'bad Content-Length'})
        body = self.rfile.read(n)
        try:
            x, rate = wav_to_float(body)
        except ValueError as e:
            return self._json(400, {'error': str(e)})
        t0 = time.perf_counter()
        try:
            with self.server.lock:  # 認識器は1本。順番に処理する
                s = self.server.rec.create_stream()
                s.accept_waveform(rate, x)
                self.server.rec.decode_stream(s)
                text = s.result.text
        except Exception as e:  # noqa: BLE001 - 失敗は呼び出し側(WindVoice)へ返す
            log('認識エラー:', repr(e))
            return self._json(500, {'error': repr(e)})
        self._json(200, {'text': (text or '').strip(), 'ms': round((time.perf_counter() - t0) * 1000)})


def _pid_alive_func():
    """pid -> 生きているか、を返す関数。psutil があれば使い、無ければ OS の仕組みで調べる。"""
    try:
        import psutil
        return psutil.pid_exists
    except ImportError:
        pass
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)
        query_limited, still_active = 0x1000, 259

        def alive(p):
            h = k32.OpenProcess(query_limited, False, p)
            if not h:
                return False  # 消えた(または見えない)
            try:
                code = wintypes.DWORD()
                if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
                    return True
                return code.value == still_active
            finally:
                k32.CloseHandle(h)
        return alive

    def alive(p):
        try:
            os.kill(p, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True
    return alive


def watch_parent(pid):
    """親プロセスが消えたら自分も終わる。"""
    alive = _pid_alive_func()

    def loop():
        while True:
            time.sleep(2)
            if not alive(pid):
                log('親プロセス(%d)が消えたので終了します' % pid)
                os._exit(0)
    threading.Thread(target=loop, daemon=True).start()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model-dir', required=True)
    ap.add_argument('--port', type=int, default=5312)
    ap.add_argument('--threads', type=int, default=4)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--parent-pid', type=int, default=0)
    ap.add_argument('--above-normal', action='store_true', help='Windows: 優先度を「通常以上」にする(ほかの重い処理で CPU が混んでいても認識が遅れにくい)')
    a = ap.parse_args()
    if a.host not in ('127.0.0.1', 'localhost', '::1'):
        ap.error('--host は 127.0.0.1 のみ(外には公開しません)')

    if a.above_normal:
        try:
            import psutil
            psutil.Process().nice(psutil.ABOVE_NORMAL_PRIORITY_CLASS if os.name == 'nt' else -5)
        except Exception as e:  # noqa: BLE001 - 優先度が変えられなくても動かす
            log('優先度を変えられませんでした:', repr(e))

    t0 = time.perf_counter()
    rec = load_recognizer(a.model_dir, a.threads)
    # 初回の遅さ(メモリ確保など)を先に済ませる
    import numpy as np
    s = rec.create_stream()
    s.accept_waveform(16000, np.zeros(8000, dtype=np.float32))
    rec.decode_stream(s)
    load_ms = round((time.perf_counter() - t0) * 1000)
    log('モデル読み込み完了 %d ms (threads=%d)' % (load_ms, a.threads))

    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    srv.rec = rec
    srv.lock = threading.Lock()
    srv.state = {'model': os.path.basename(os.path.normpath(a.model_dir)), 'threads': a.threads, 'load_ms': load_ms}
    if a.parent_pid:
        watch_parent(a.parent_pid)
    log('待ち受け開始 http://%s:%d' % (a.host, a.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
