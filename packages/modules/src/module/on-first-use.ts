export function onFirstUse<T>(make: () => T): () => T {
  let made: { readonly value: T } | undefined;
  return () => {
    made ??= { value: make() };
    return made.value;
  };
}
