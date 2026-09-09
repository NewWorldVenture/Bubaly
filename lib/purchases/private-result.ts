/** A pending approval can be reused by equivalent requests from its owner. */
export function purchaseApprovalPath(approvalId: string): string {
  return `/dashboard/assistant/purchases/${encodeURIComponent(approvalId)}`;
}
