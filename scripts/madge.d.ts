declare module "madge" {
  interface MadgeConfig {
    fileExtensions?: string[];
    detectiveOptions?: Record<string, Record<string, unknown>>;
  }
  interface MadgeResult {
    circular(): string[][];
    warnings(): { skipped: string[] };
    obj(): Record<string, string[]>;
  }
  export default function madge(path: string, config?: MadgeConfig): Promise<MadgeResult>;
}
