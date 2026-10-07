import { z } from "zod";

/**
 * Paying carriers by ACH. A payer's bank takes a NACHA file: credits to each
 * carrier's account, one entry per invoice, with the invoice number in an
 * addenda record so the carrier's bank statement says what was paid.
 */

/** ABA routing number: nine digits whose weighted sum (3, 7, 1) is a multiple of 10. */
export function isValidRoutingNumber(r: string): boolean {
  if (!/^\d{9}$/.test(r)) return false;
  const d = [...r].map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

export const AccountType = z.enum(["CHECKING", "SAVINGS"]);
export type AccountType = z.infer<typeof AccountType>;

/** Bank details a carrier (or its factoring company) is paid to. */
export const BankAccountInput = z.object({
  holderName: z.string().trim().min(1).max(60),
  routingNumber: z.string().trim().refine(isValidRoutingNumber, "That isn't a valid 9-digit routing number"),
  accountNumber: z.string().trim().regex(/^\d{4,17}$/, "Account numbers are 4 to 17 digits"),
  accountType: AccountType,
});
export type BankAccountInput = z.infer<typeof BankAccountInput>;

/** What may be shown about a bank account: never the full account number. */
export const BankAccountSummary = z.object({
  /** The stored account; each change is a new one, so invoices keep the account they were issued with. */
  id: z.string(),
  holderName: z.string(),
  routingNumber: z.string(),
  last4: z.string(),
  accountType: AccountType,
  setAt: z.string(),
  setByAccountId: z.string(),
});
export type BankAccountSummary = z.infer<typeof BankAccountSummary>;

/** A payer's ACH origination details, from its bank. */
export const AchOriginator = z.object({
  /** As the payee will see it on their statement, up to 16 characters. */
  companyName: z.string().trim().min(1).max(16),
  /** The 10-character company ID the bank assigned, often "1" plus the EIN. */
  companyId: z.string().trim().regex(/^[A-Za-z0-9 ]{10}$/, "Company IDs are 10 characters"),
  /** The payer's bank (the originating bank). */
  bankRoutingNumber: z.string().trim().refine(isValidRoutingNumber, "That isn't a valid 9-digit routing number"),
  bankName: z.string().trim().min(1).max(23),
  /** Some banks want a different immediate origin; defaults to the company ID. */
  immediateOrigin: z.string().trim().regex(/^[A-Za-z0-9 ]{10}$/).optional(),
});
export type AchOriginator = z.infer<typeof AchOriginator>;

export interface AchCredit {
  /** Shown to the payee's bank as the receiver. */
  name: string;
  routingNumber: string;
  accountNumber: string;
  accountType: AccountType;
  amountCents: number;
  /** Identifies the payment to the payee, for example the invoice number. */
  id: string;
  /** Remittance detail carried in the addenda record. */
  addenda?: string;
}

export interface NachaFile {
  text: string;
  /** Trace number per credit, in the order given. */
  traceNumbers: string[];
  entryCount: number;
  totalCents: number;
  entryHash: string;
}

const alnum = (s: string, n: number) => s.toUpperCase().replace(/[^A-Z0-9 .,&'/-]/g, " ").slice(0, n).padEnd(n, " ");
const num = (v: number | string, n: number) => {
  const s = String(v);
  if (s.length > n) throw new Error(`${s} doesn't fit in ${n} digits`);
  return s.padStart(n, "0");
};
const yymmdd = (iso: string) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);

/**
 * A NACHA file of CCD credits from one payer, effective on `effectiveDate`
 * (YYYY-MM-DD). Records are 94 characters; the file is padded to whole blocks
 * of ten records, as banks expect.
 */
export function buildNachaFile(opts: { originator: AchOriginator; credits: AchCredit[]; effectiveDate: string; createdAt: string; fileIdModifier?: string; description?: string; batchNumber?: number }): NachaFile {
  const o = opts.originator;
  if (!opts.credits.length) throw new Error("No payments to send");
  const odfi = o.bankRoutingNumber.slice(0, 8);
  const batch = opts.batchNumber ?? 1;
  const lines: string[] = [];

  lines.push(
    "1" + "01" + " " + o.bankRoutingNumber + alnum(o.immediateOrigin ?? o.companyId, 10) + yymmdd(opts.createdAt) + opts.createdAt.slice(11, 13) + opts.createdAt.slice(14, 16) + (opts.fileIdModifier ?? "A").slice(0, 1).toUpperCase() + "094" + "10" + "1" + alnum(o.bankName, 23) + alnum(o.companyName, 23) + alnum("", 8),
  );
  lines.push("5" + "220" + alnum(o.companyName, 16) + alnum("", 20) + alnum(o.companyId, 10) + "CCD" + alnum(opts.description ?? "VENDOR PAY", 10) + alnum("", 6) + yymmdd(opts.effectiveDate) + "   " + "1" + odfi + num(batch, 7));

  let hash = 0;
  let total = 0;
  let records = 0;
  const traceNumbers: string[] = [];
  opts.credits.forEach((c, i) => {
    if (!isValidRoutingNumber(c.routingNumber)) throw new Error(`Invalid routing number for ${c.name}`);
    if (!Number.isInteger(c.amountCents) || c.amountCents <= 0) throw new Error(`Invalid amount for ${c.name}`);
    const seq = num(i + 1, 7);
    const trace = odfi + seq;
    traceNumbers.push(trace);
    hash += Number(c.routingNumber.slice(0, 8));
    total += c.amountCents;
    lines.push("6" + (c.accountType === "SAVINGS" ? "32" : "22") + c.routingNumber + c.accountNumber.padEnd(17, " ") + num(c.amountCents, 10) + alnum(c.id, 15) + alnum(c.name, 22) + "  " + (c.addenda ? "1" : "0") + trace);
    records++;
    if (c.addenda) {
      lines.push("7" + "05" + c.addenda.slice(0, 80).padEnd(80, " ") + "0001" + seq);
      records++;
    }
  });
  const entryHash = num(hash % 10_000_000_000, 10);
  lines.push("8" + "220" + num(records, 6) + entryHash + num(0, 12) + num(total, 12) + alnum(o.companyId, 10) + " ".repeat(19) + " ".repeat(6) + odfi + num(batch, 7));
  const blocks = Math.ceil((lines.length + 1) / 10);
  lines.push("9" + num(1, 6) + num(blocks, 6) + num(records, 8) + entryHash + num(0, 12) + num(total, 12) + " ".repeat(39));
  while (lines.length % 10) lines.push("9".repeat(94));

  for (const l of lines) if (l.length !== 94) throw new Error(`NACHA record is ${l.length} characters, not 94: ${l}`);
  return { text: lines.join("\n") + "\n", traceNumbers, entryCount: opts.credits.length, totalCents: total, entryHash };
}

/** Remittance for an addenda record, in the X12 RMR style banks pass through: invoice number and amount. */
export const rmrAddenda = (invoiceNumber: string, amount: number) => `RMR*IV*${invoiceNumber.replace(/[*\\~]/g, "")}**${amount.toFixed(2)}\\`;

/** The next business day on or after `iso` (YYYY-MM-DD), skipping weekends. */
export function nextBusinessDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
