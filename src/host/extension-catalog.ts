export type OfficialExtension = {
  id: string;
  name: string;
  description: string;
  repositoryUrl: string;
  manifestUrl: string;
};

export const OFFICIAL_EXTENSIONS: readonly OfficialExtension[] = [
  {
    id: "scheduler",
    name: "Scheduler",
    description: "Create normal ZCode tasks from timezone-aware cron schedules while ZCode is open.",
    repositoryUrl: "https://github.com/notmike101/zcode-scheduler",
    manifestUrl: "https://github.com/notmike101/zcode-scheduler/releases/latest/download/extension-update.json",
  },
  {
    id: "zcode-tps",
    name: "Token Speed",
    description: "Show live estimates and exact provider-reported token throughput for ZCode sessions.",
    repositoryUrl: "https://github.com/notmike101/zcode-tps-extension",
    manifestUrl: "https://github.com/notmike101/zcode-tps-extension/releases/latest/download/extension-update.json",
  },
];
