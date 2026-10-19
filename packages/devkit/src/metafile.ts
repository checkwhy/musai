export interface EsbuildMetafileImport {
  readonly path: string;
  readonly kind: string;
  readonly original?: string;
}

export interface EsbuildMetafileInput {
  readonly bytes: number;
  readonly imports: readonly EsbuildMetafileImport[];
  readonly format?: string;
}

/** esbuild's build metadata, a shape esbuild defines and this kernel only reads. */
export interface EsbuildMetafile {
  readonly inputs: Readonly<Record<string, EsbuildMetafileInput>>;
  readonly outputs: Readonly<Record<string, { readonly entryPoint?: string }>>;
}
