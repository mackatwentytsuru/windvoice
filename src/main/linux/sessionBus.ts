import net from 'node:net';

const DBUS_DAEMON = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const CALL_TIMEOUT_MS = 1_500;

interface HeaderField {
  code: number;
  type: 's' | 'o' | 'g';
  value: string;
}

interface ParsedMessage {
  type: number;
  replySerial: number | null;
  bodyOffset: number;
}

function align(value: number, boundary: number): number {
  return Math.ceil(value / boundary) * boundary;
}

function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const out = Buffer.alloc(4 + bytes.length + 1);
  out.writeUInt32LE(bytes.length, 0);
  bytes.copy(out, 4);
  return out;
}

function encodeSignature(value: string): Buffer {
  const bytes = Buffer.from(value, 'ascii');
  const out = Buffer.alloc(1 + bytes.length + 1);
  out.writeUInt8(bytes.length, 0);
  bytes.copy(out, 1);
  return out;
}

function encodeHeaderField(field: HeaderField): Buffer {
  const prefix = Buffer.from([field.code, 1, field.type.charCodeAt(0), 0]);
  const value =
    field.type === 'g' ? encodeSignature(field.value) : encodeString(field.value);
  return Buffer.concat([prefix, value]);
}

function buildMethodCall(
  serial: number,
  member: string,
  bodySignature?: string,
  body: Buffer<ArrayBufferLike> = Buffer.alloc(0)
): Buffer {
  const headerFields: HeaderField[] = [
    { code: 1, type: 'o', value: DBUS_PATH },
    { code: 2, type: 's', value: DBUS_INTERFACE },
    { code: 3, type: 's', value: member },
    { code: 6, type: 's', value: DBUS_DAEMON }
  ];
  if (bodySignature) {
    headerFields.push({ code: 8, type: 'g', value: bodySignature });
  }

  let fields = Buffer.alloc(0);
  for (const field of headerFields) {
    const padding = align(fields.length, 8) - fields.length;
    if (padding > 0) fields = Buffer.concat([fields, Buffer.alloc(padding)]);
    fields = Buffer.concat([fields, encodeHeaderField(field)]);
  }

  const fixed = Buffer.alloc(16);
  fixed.writeUInt8('l'.charCodeAt(0), 0);
  fixed.writeUInt8(1, 1); // METHOD_CALL
  fixed.writeUInt8(0, 2);
  fixed.writeUInt8(1, 3);
  fixed.writeUInt32LE(body.length, 4);
  fixed.writeUInt32LE(serial, 8);
  fixed.writeUInt32LE(fields.length, 12);
  const padding = align(fixed.length + fields.length, 8) - (fixed.length + fields.length);
  return Buffer.concat([fixed, fields, Buffer.alloc(padding), body]);
}

function readUInt32(message: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? message.readUInt32LE(offset) : message.readUInt32BE(offset);
}

function parseMessage(message: Buffer): ParsedMessage | null {
  if (message.length < 16) return null;
  const endian = String.fromCharCode(message[0]!);
  if (endian !== 'l' && endian !== 'B') return null;
  const littleEndian = endian === 'l';
  const fieldsLength = readUInt32(message, 12, littleEndian);
  const fieldsEnd = 16 + fieldsLength;
  if (fieldsEnd > message.length) return null;

  let replySerial: number | null = null;
  let offset = 16;
  while (offset < fieldsEnd) {
    offset = align(offset, 8);
    if (offset >= fieldsEnd) break;
    const code = message[offset]!;
    offset += 1;
    if (offset >= fieldsEnd) return null;
    const signatureLength = message[offset]!;
    offset += 1;
    if (offset + signatureLength + 1 > fieldsEnd) return null;
    const signature = message
      .subarray(offset, offset + signatureLength)
      .toString('ascii');
    offset += signatureLength + 1;

    if (signature === 'u') {
      offset = align(offset, 4);
      if (offset + 4 > fieldsEnd) return null;
      const value = readUInt32(message, offset, littleEndian);
      if (code === 5) replySerial = value;
      offset += 4;
    } else if (signature === 's' || signature === 'o') {
      offset = align(offset, 4);
      if (offset + 4 > fieldsEnd) return null;
      const length = readUInt32(message, offset, littleEndian);
      offset += 4 + length + 1;
    } else if (signature === 'g') {
      if (offset >= fieldsEnd) return null;
      const length = message[offset]!;
      offset += 1 + length + 1;
    } else {
      return null;
    }
  }

  return {
    type: message[1]!,
    replySerial,
    bodyOffset: align(fieldsEnd, 8)
  };
}

function sessionBusPath(): string | null {
  const address = process.env['DBUS_SESSION_BUS_ADDRESS'];
  if (address) {
    for (const candidate of address.split(';')) {
      if (!candidate.startsWith('unix:')) continue;
      const values = new Map<string, string>();
      for (const part of candidate.slice('unix:'.length).split(',')) {
        const separator = part.indexOf('=');
        if (separator <= 0) continue;
        const key = part.slice(0, separator);
        const raw = part.slice(separator + 1);
        try {
          values.set(key, decodeURIComponent(raw));
        } catch {
          values.set(key, raw);
        }
      }
      const path = values.get('path');
      if (path) return path;
      const abstract = values.get('abstract');
      if (abstract) return `\0${abstract}`;
    }
  }
  const uid = process.getuid?.();
  return uid === undefined ? null : `/run/user/${uid}/bus`;
}

/**
 * Query the session bus daemon's NameHasOwner method without spawning
 * gdbus/dbus-send or adding a native dependency.
 */
export function sessionBusNameHasOwner(name: string): Promise<boolean> {
  const socketPath = sessionBusPath();
  if (!socketPath) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let authenticated = false;
    let buffer = Buffer.alloc(0);
    const socket = net.createConnection({ path: socketPath });

    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), CALL_TIMEOUT_MS);
    timer.unref();

    socket.on('connect', () => {
      const uid = String(process.getuid?.() ?? '');
      const externalId = Buffer.from(uid, 'ascii').toString('hex');
      socket.write(`\0AUTH EXTERNAL ${externalId}\r\n`);
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!authenticated) {
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd < 0) return;
        const response = buffer.subarray(0, lineEnd).toString('ascii');
        buffer = buffer.subarray(lineEnd + 2);
        if (!response.startsWith('OK ')) {
          finish(false);
          return;
        }
        authenticated = true;
        socket.write('BEGIN\r\n');
        socket.write(buildMethodCall(1, 'Hello'));
      }

      while (buffer.length >= 16) {
        const littleEndian = buffer[0] === 'l'.charCodeAt(0);
        if (!littleEndian && buffer[0] !== 'B'.charCodeAt(0)) {
          finish(false);
          return;
        }
        const bodyLength = readUInt32(buffer, 4, littleEndian);
        const fieldsLength = readUInt32(buffer, 12, littleEndian);
        const messageLength = align(16 + fieldsLength, 8) + bodyLength;
        if (buffer.length < messageLength) return;
        const message = buffer.subarray(0, messageLength);
        buffer = buffer.subarray(messageLength);
        const parsed = parseMessage(message);
        if (!parsed) {
          finish(false);
          return;
        }
        if (parsed.replySerial === 1) {
          if (parsed.type !== 2) {
            finish(false);
            return;
          }
          socket.write(buildMethodCall(2, 'NameHasOwner', 's', encodeString(name)));
        } else if (parsed.replySerial === 2) {
          if (parsed.type !== 2 || parsed.bodyOffset + 4 > message.length) {
            finish(false);
            return;
          }
          finish(readUInt32(message, parsed.bodyOffset, littleEndian) !== 0);
          return;
        }
      }
    });
  });
}

export const __test = {
  buildMethodCall,
  parseMessage
};
