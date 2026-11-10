(function () {
  'use strict';

  const PRODUCT_PRICE = 49.99;
  let serverConfig = null;

  // DOM Elements
  const checkoutSection = document.getElementById('checkout-section');
  const successScreen = document.getElementById('success-screen');
  const quantitySelect = document.getElementById('quantity-select');
  const unitPriceEl = document.getElementById('unit-price');
  const subtotalEl = document.getElementById('subtotal');
  const totalAmountEl = document.getElementById('total-amount');
  const policyHintEl = document.getElementById('policy-hint');

  const alertApprovalEl = document.getElementById('alert-approval');
  const alertCancelEl = document.getElementById('alert-cancel');
  const alertErrorEl = document.getElementById('alert-error');

  const captureIdValEl = document.getElementById('capture-id-val');
  const orderIdValEl = document.getElementById('order-id-val');
  const captureAmountValEl = document.getElementById('capture-amount-val');
  const captureStatusValEl = document.getElementById('capture-status-val');

  const paypalContainer = document.getElementById('paypal-button-container');
  const loadingIndicator = document.getElementById('loading-indicator');
  const btnReset = document.getElementById('btn-reset');

  // Utility to hide all alert banners
  function hideAlerts() {
    alertApprovalEl.style.display = 'none';
    alertCancelEl.style.display = 'none';
    alertErrorEl.style.display = 'none';
  }

  function showApprovalMessage(message) {
    hideAlerts();
    alertApprovalEl.textContent = message;
    alertApprovalEl.style.display = 'block';
  }

  function showCancelMessage(message) {
    hideAlerts();
    alertCancelEl.textContent = message;
    alertCancelEl.style.display = 'block';
  }

  function showErrorMessage(message) {
    hideAlerts();
    alertErrorEl.textContent = message;
    alertErrorEl.style.display = 'block';
  }

  // Update order summary calculations
  function updateSummary() {
    const qty = parseInt(quantitySelect.value, 10);
    const total = Math.round(qty * PRODUCT_PRICE * 100) / 100;

    unitPriceEl.textContent = `$${PRODUCT_PRICE.toFixed(2)} USD`;
    subtotalEl.textContent = `$${total.toFixed(2)} USD`;
    totalAmountEl.textContent = `$${total.toFixed(2)} USD`;

    if (serverConfig && total > serverConfig.maxAmount) {
      policyHintEl.style.display = 'block';
      policyHintEl.textContent = `Note: Total ($${total.toFixed(2)}) exceeds $${serverConfig.maxAmount.toFixed(2)} limit and will require administrative approval.`;
    } else {
      policyHintEl.style.display = 'none';
    }
  }

  quantitySelect.addEventListener('change', () => {
    hideAlerts();
    updateSummary();
  });

  btnReset.addEventListener('click', () => {
    quantitySelect.value = '1';
    hideAlerts();
    updateSummary();
    successScreen.style.display = 'none';
    checkoutSection.style.display = 'block';
  });

  // Step 1: Fetch public server config and initialize PayPal SDK
  async function initApp() {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) {
        throw new Error(`Failed to load server config (HTTP ${res.status})`);
      }

      serverConfig = await res.json();
      updateSummary();

      // Dynamically load the PayPal JavaScript SDK
      loadPayPalSDK(serverConfig.paypalClientId);
    } catch (err) {
      loadingIndicator.style.display = 'none';
      showErrorMessage('Unable to connect to PayPilot server configuration.');
      console.error('[PayPilot Init]', err);
    }
  }

  function loadPayPalSDK(clientId) {
    if (!clientId) {
      loadingIndicator.style.display = 'none';
      showErrorMessage('PayPal Client ID is not configured on the server.');
      return;
    }

    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(
      clientId
    )}&currency=USD&intent=capture`;
    script.async = true;

    script.onload = () => {
      loadingIndicator.style.display = 'none';
      renderPayPalButtons();
    };

    script.onerror = () => {
      loadingIndicator.style.display = 'none';
      showErrorMessage('Failed to load PayPal JavaScript SDK. Check your internet connection.');
    };

    document.head.appendChild(script);
  }

  // Step 2: Render PayPal Smart Buttons
  function renderPayPalButtons() {
    if (!window.paypal || !window.paypal.Buttons) {
      showErrorMessage('PayPal SDK did not initialize properly.');
      return;
    }

    window.paypal
      .Buttons({
        style: {
          layout: 'vertical',
          color: 'gold',
          shape: 'rect',
          label: 'checkout',
        },

        // Client initiates order creation on backend
        createOrder: async () => {
          hideAlerts();
          const quantity = parseInt(quantitySelect.value, 10);

          // Generate a stable checkoutAttemptId UUID once per logical checkout attempt
          const checkoutAttemptId =
            typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
                  (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
                );

          let res;
          let data;

          try {
            res = await fetch('/api/orders', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                productId: 'demo-headphones',
                quantity: quantity,
                checkoutAttemptId: checkoutAttemptId,
              }),
            });
            data = await res.json();
          } catch (err) {
            showErrorMessage('Network error occurred while creating order.');
            throw err;
          }

          // Handle server-side approval rule
          if (res.status === 202 || data.status === 'approval_required') {
            const reason =
              data.reason ||
              'This transaction requires administrative approval before it can be processed.';
            showApprovalMessage(reason);
            // Throw error to cleanly prevent the PayPal payment popup from opening
            throw new Error('Approval required');
          }

          if (!res.ok || !data.orderId) {
            const errorMsg = data.error?.message || 'Server failed to initiate PayPal order.';
            showErrorMessage(errorMsg);
            throw new Error(errorMsg);
          }

          return data.orderId;
        },

        // Client captures authorized order through backend
        onApprove: async (data) => {
          hideAlerts();
          loadingIndicator.style.display = 'flex';
          loadingIndicator.querySelector('span').textContent = 'Verifying and capturing payment...';

          try {
            const res = await fetch(`/api/orders/${encodeURIComponent(data.orderID)}/capture`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            });

            const captureResult = await res.json();
            loadingIndicator.style.display = 'none';

            if (!res.ok) {
              const errorMsg = captureResult.error?.message || 'Failed to capture payment.';
              showErrorMessage(errorMsg);
              return;
            }

            // Strictly show "Payment verified" ONLY when status is COMPLETED
            if (captureResult.status === 'COMPLETED') {
              showSuccessScreen(captureResult);
            } else {
              showErrorMessage(
                `Payment verification unconfirmed. Server status: ${captureResult.status}`
              );
            }
          } catch (err) {
            loadingIndicator.style.display = 'none';
            showErrorMessage('Network error while completing payment capture.');
            console.error('[Capture Error]', err);
          }
        },

        onCancel: () => {
          showCancelMessage('PayPal transaction was cancelled. No charges were made.');
        },

        onError: (err) => {
          // If the error was our deliberate approval_required abort, do not show generic error
          if (err && err.message === 'Approval required') {
            return;
          }
          console.error('[PayPal Buttons Error]', err);
          showErrorMessage('A PayPal window or processing error occurred. Please try again.');
        },
      })
      .render('#paypal-button-container');
  }

  // Step 3: Render verified payment receipt
  function showSuccessScreen(captureResult) {
    hideAlerts();
    checkoutSection.style.display = 'none';

    captureIdValEl.textContent = captureResult.captureId || 'N/A';
    orderIdValEl.textContent = captureResult.orderId || 'N/A';
    captureAmountValEl.textContent = `$${captureResult.amount} ${captureResult.currency}`;
    captureStatusValEl.textContent = captureResult.status;

    successScreen.style.display = 'block';
  }

  initApp();
})();
