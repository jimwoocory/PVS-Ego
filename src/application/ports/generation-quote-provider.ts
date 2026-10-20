import type { ProviderQuote, QuoteItem } from "../../domain/generation-quote.js";
/** Side-effect-free quotation only. Implementations must never call submit/upload/login. */
export interface GenerationQuoteProvider {
  quote(input: { requestHash: string; item: QuoteItem }): Promise<ProviderQuote>;
}
