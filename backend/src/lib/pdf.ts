// PDF generation for Allotment Letter, Booking Form, Quotation, Demand Letter,
// Receipt. Produces a self-contained, print-ready HTML document that can be
// rendered to PDF by the client (window.print) or by Puppeteer in a worker.
// Keeping it HTML-first avoids a heavy headless-Chromium dependency in the API
// container while remaining a single source of truth for document layout.
import { env } from '../config/env';
import { formatPaise } from './money';

interface DocRow {
  label: string;
  value: string;
}

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>
<title>${title}</title>
<style>
  *{box-sizing:border-box} body{font-family:Inter,Arial,sans-serif;color:#1f2937;margin:0;padding:48px}
  .letterhead{display:flex;justify-content:space-between;border-bottom:3px solid #4f46e5;padding-bottom:16px;margin-bottom:24px}
  .company{font-size:20px;font-weight:700;color:#4f46e5}
  h1{font-size:18px;text-transform:uppercase;letter-spacing:1px}
  table{width:100%;border-collapse:collapse;margin:16px 0}
  td,th{padding:8px 10px;border:1px solid #e5e7eb;font-size:13px;text-align:left}
  th{background:#f3f4f6}
  .totals td{font-weight:700}
  .muted{color:#6b7280;font-size:12px}
  .sign{margin-top:64px;display:flex;justify-content:space-between}
</style></head><body>
<div class="letterhead">
  <div class="company">${env.COMPANY_NAME}</div>
  <div class="muted">Generated ${new Date().toISOString().slice(0, 10)}</div>
</div>
${bodyHtml}
</body></html>`;
}

const rows = (data: DocRow[]) =>
  `<table>${data.map((d) => `<tr><th style="width:35%">${d.label}</th><td>${d.value}</td></tr>`).join('')}</table>`;

export function allotmentLetterHtml(b: {
  bookingNumber: string;
  customerName: string;
  unitLabel: string;
  projectName: string;
  totalPaise: bigint;
  bookingDate: string;
}): string {
  return shell(
    `Allotment Letter ${b.bookingNumber}`,
    `<h1>Allotment Letter</h1>
     <p>Dear ${b.customerName},</p>
     <p>We are pleased to confirm the allotment of the following unit in <b>${b.projectName}</b>.</p>
     ${rows([
       { label: 'Booking No.', value: b.bookingNumber },
       { label: 'Unit', value: b.unitLabel },
       { label: 'Total Consideration', value: formatPaise(b.totalPaise) },
       { label: 'Booking Date', value: b.bookingDate },
     ])}
     <div class="sign"><div>Authorised Signatory<br/>${env.COMPANY_NAME}</div><div>Allottee Signature</div></div>`,
  );
}

export function quotationHtml(q: {
  quoteNumber: string;
  customerName: string;
  unitLabel: string;
  lineItems: { label: string; amountPaise: bigint; gstPaise: bigint }[];
  subtotalPaise: bigint;
  gstPaise: bigint;
  totalPaise: bigint;
  validUntil?: string;
}): string {
  const items = q.lineItems
    .map(
      (li) =>
        `<tr><td>${li.label}</td><td style="text-align:right">${formatPaise(li.amountPaise)}</td><td style="text-align:right">${formatPaise(li.gstPaise)}</td></tr>`,
    )
    .join('');
  return shell(
    `Quotation ${q.quoteNumber}`,
    `<h1>Quotation ${q.quoteNumber}</h1>
     <p>Customer: <b>${q.customerName}</b> &nbsp;|&nbsp; Unit: <b>${q.unitLabel}</b></p>
     <table><thead><tr><th>Component</th><th style="text-align:right">Amount</th><th style="text-align:right">GST</th></tr></thead>
     <tbody>${items}</tbody>
     <tfoot class="totals">
       <tr><td>Subtotal</td><td style="text-align:right">${formatPaise(q.subtotalPaise)}</td><td style="text-align:right">${formatPaise(q.gstPaise)}</td></tr>
       <tr><td>Total Cost of Ownership</td><td colspan="2" style="text-align:right">${formatPaise(q.totalPaise)}</td></tr>
     </tfoot></table>
     ${q.validUntil ? `<p class="muted">Valid until ${q.validUntil}. Stamp duty / registration shown for information only.</p>` : ''}`,
  );
}

export function demandLetterHtml(d: {
  demandNumber: string;
  bookingNumber: string;
  milestoneLabel: string;
  amountPaise: bigint;
  gstPaise: bigint;
  totalPaise: bigint;
  dueDate: string;
}): string {
  return shell(
    `Demand ${d.demandNumber}`,
    `<h1>Demand Letter</h1>
     ${rows([
       { label: 'Demand No.', value: d.demandNumber },
       { label: 'Booking No.', value: d.bookingNumber },
       { label: 'Milestone', value: d.milestoneLabel },
       { label: 'Amount', value: formatPaise(d.amountPaise) },
       { label: 'GST', value: formatPaise(d.gstPaise) },
       { label: 'Total Payable', value: formatPaise(d.totalPaise) },
       { label: 'Due Date', value: d.dueDate },
     ])}`,
  );
}

export function receiptHtml(r: {
  receiptNumber: string;
  bookingNumber: string;
  amountPaise: bigint;
  gstPaise: bigint;
  mode: string;
  receivedAt: string;
}): string {
  return shell(
    `Receipt ${r.receiptNumber}`,
    `<h1>Payment Receipt</h1>
     ${rows([
       { label: 'Receipt No.', value: r.receiptNumber },
       { label: 'Booking No.', value: r.bookingNumber },
       { label: 'Amount Received', value: formatPaise(r.amountPaise) },
       { label: 'GST', value: formatPaise(r.gstPaise) },
       { label: 'Mode', value: r.mode },
       { label: 'Received On', value: r.receivedAt },
     ])}
     <p class="muted">This is a computer-generated receipt.</p>`,
  );
}
