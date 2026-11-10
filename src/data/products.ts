export interface Product {
  id: string;
  name: string;
  description: string;
  price: number; // Unit price in USD
  currency: 'USD';
}

/**
 * DEMO PRODUCT CATALOG
 * ---------------------
 * Authoritative server-side product catalog for PayPilot Checkout demo.
 * The server never trusts client-supplied pricing or currency data.
 */
export const DEMO_PRODUCTS: Record<string, Product> = {
  'demo-headphones': {
    id: 'demo-headphones',
    name: 'Demo Wireless Headphones',
    description: 'High fidelity wireless headphones with active noise cancellation (Demo Product)',
    price: 49.99,
    currency: 'USD',
  },
};

export function getProductById(productId: string): Product | undefined {
  return DEMO_PRODUCTS[productId];
}

