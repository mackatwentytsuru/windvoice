export interface GeneralSettingsVisibility {
  typeInsertion: boolean;
  clipboardHistoryExclusion: boolean;
}

export function generalSettingsVisibility(platform: string): GeneralSettingsVisibility {
  const windows = platform === 'win32';
  return {
    typeInsertion: windows,
    clipboardHistoryExclusion: windows
  };
}
