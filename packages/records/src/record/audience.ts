declare const audienceBrand: unique symbol;

/** Who a release reaches: `public`, a key, an identity or a name the `audiences` file declares. */
export type Audience = string & { readonly [audienceBrand]: true };

export type AudienceForm =
  | { readonly form: "public" }
  | { readonly form: "key"; readonly fingerprint: string }
  | { readonly form: "identity"; readonly issuer: string; readonly subject: string }
  | { readonly form: "name"; readonly name: string };

/** `ssh-keygen -l`'s fingerprint: SHA-256 in unpadded base64. */
const KEY = /^key:(SHA256:[A-Za-z0-9+/]{43})$/;

const IDENTITY = /^identity:(https:\/\/[^#\s]+)#(\S+)$/;

/** No colon, so a name never collides with a prefixed form. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseAudience(text: string): AudienceForm {
  if (text === "public") {
    return { form: "public" };
  }
  const key = KEY.exec(text);
  if (key !== null) {
    return { form: "key", fingerprint: key[1]! };
  }
  const identity = IDENTITY.exec(text);
  if (identity !== null) {
    return { form: "identity", issuer: identity[1]!, subject: identity[2]! };
  }
  if (NAME.test(text)) {
    return { form: "name", name: text };
  }
  throw new RangeError(
    `not an audience: ${JSON.stringify(text)}; name public, key:SHA256:<fingerprint>, identity:<https issuer>#<subject> or a name`,
  );
}

export function isAudience(text: string): text is Audience {
  try {
    parseAudience(text);
    return true;
  } catch {
    return false;
  }
}
