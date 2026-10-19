declare const slotBrand: unique symbol;
/** A claim's identity key; a record's id names one assertion, the slot names the claim. */
export type Slot = string & { readonly [slotBrand]: true };
