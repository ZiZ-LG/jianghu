export type SalesCustomerType = 1 | 2 | 3 | 4;

export class SalesClassificationRequiredError extends Error {
  readonly code = 'sales_customer_type_required';

  constructor() {
    super('sales classification is required before creating an opportunity');
    this.name = 'SalesClassificationRequiredError';
  }
}

/** Sales-only adapter guard. Generic Customer code must not call this helper. */
export function requireSalesCustomerType(customerType: number | null | undefined): SalesCustomerType {
  if (customerType === 1 || customerType === 2 || customerType === 3 || customerType === 4) return customerType;
  throw new SalesClassificationRequiredError();
}
