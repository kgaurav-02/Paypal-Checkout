(function () {
  'use strict';

  const PRODUCT_PRICE = 49.99;
  let serverConfig = null;
  let sdkLoaded = false;
  let pendingApprovalInfo = null;

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

  // Utility to clear/hide all alert banners
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
    pendingApprovalInfo = null;
  });

  btnReset.addEventListener('click', () => {
    quantitySelect.value = '1';
    hideAlerts();
    updateSummary();
    pendingApprovalInfo = null;
    successScreen.style.display = 'none';
    checkoutSection.style.display = 'block';
  });

  // STEP 3: Read /api/config first, then inject the SDK script tag once at runtime
  async function initApp() {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) {
        throw new Error(`Failed to load server config (HTTP ${res.status})`);
      }

      serverConfig = await res.json();
      updateSummary();

      // Load SDK once and only after config response arrives
      if (!sdkLoaded && serverConfig.paypalClientId) {
        sdkLoaded = true;
        loadPayPalSDK(serverConfig.paypalClientId);
      } else if (!serverConfig.paypalClientId) {
        loadingIndicator.style.display = 'none';
        showErrorMessage('PayPal Client ID is missing in server configuration.');
      }
    } catch (err) {
      loadingIndicator.style.display = 'none';
      showErrorMessage('Unable to connect to PayPilot server configuration.');
      console.error('[PayPilot Init Error]', err);
    }
  }

  /**
   * Injects the PayPal JavaScript SDK script tag placed immediately before public/app.js.
   */
  function loadPayPalSDK(clientId) {
    const script = document.createElement('script');
    script.id = 'paypal-js-sdk';
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(
      clientId
    )}&currency=USD&intent=capture`;
    script.async = true;

    script.onload = () => {
      loadingIndicator.style.display = 'none';
      renderPayPalButtons();
    };

    script.onerror = (e) => {
      loadingIndicator.style.display = 'none';
      showErrorMessage('Failed to load PayPal JavaScript SDK. Check network or credentials.');
      console.error('[PayPal SDK Load Error]', e);
    };

    // Locate public/app.js script tag to insert SDK script tag immediately before it
    const appScript = document.querySelector('script[src*="app.js"]');
    if (appScript && appScript.parentNode) {
      appScript.parentNode.insertBefore(script, appScript);
    } else {
      document.body.appendChild(script);
    }
  }

  // STEP 4: Wire the Smart Buttons (createOrder, onApprove, onCancel, onError)
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

        // createOrder: calls POST /api/orders and returns orderId
        // If response is 202 approval_required, shows amber message and does not open PayPal
        createOrder: async () => {
          hideAlerts();
          const quantity = parseInt(quantitySelect.value, 10);

          let attemptId;
          const reqBody = {
            productId: 'demo-headphones',
            quantity: quantity,
          };

          if (pendingApprovalInfo && pendingApprovalInfo.quantity === quantity) {
            attemptId = pendingApprovalInfo.orderInternalId;
            reqBody.checkoutAttemptId = attemptId;
            reqBody.orderInternalId = attemptId;
            if (pendingApprovalInfo.approvalRequestId) {
              reqBody.approvalRequestId = pendingApprovalInfo.approvalRequestId;
            }
          } else {
            attemptId =
              typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
                    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
                  );
            reqBody.checkoutAttemptId = attemptId;
          }

          let res;
          let data;

          try {
            res = await fetch('/api/orders', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(reqBody),
            });
            data = await res.json();
          } catch (err) {
            showErrorMessage('Network error occurred while creating order.');
            throw err;
          }

          // Handle 202 approval_required: show amber message and abort PayPal popup
          if (res.status === 202 || data.status === 'approval_required') {
            pendingApprovalInfo = {
              orderInternalId: attemptId,
              approvalRequestId: data.approvalRequestId,
              quantity: quantity,
            };

            const reason =
              data.reason ||
              'This transaction requires administrative approval before it can be processed.';
            showApprovalMessage(reason);
            loadGuardian();
            loadTransactions();
            // Throwing aborts PayPal popup cleanly
            throw new Error('Approval required');
          }

          if (!res.ok || !data.orderId) {
            const errorMsg = data.error?.message || 'Server failed to initiate PayPal order.';
            showErrorMessage(errorMsg);
            throw new Error(errorMsg);
          }

          return data.orderId;
        },

        // onApprove: calls POST /api/orders/:id/capture and renders "Payment verified" only on COMPLETED
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

            // Strictly renders "Payment verified" ONLY when status is COMPLETED
            if (captureResult.status === 'COMPLETED') {
              pendingApprovalInfo = null;
              showSuccessScreen(captureResult);
              loadTransactions();
              loadGuardian();
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

        // onCancel: shows cancellation message
        onCancel: () => {
          showCancelMessage('PayPal transaction was cancelled. No charges were made.');
        },

        // onError: shows error message
        onError: (err) => {
          // If the error was our deliberate approval_required abort, suppress generic error
          if (err && err.message === 'Approval required') {
            return;
          }
          console.error('[PayPal Buttons Error]', err);
          showErrorMessage('A PayPal window or processing error occurred. Please try again.');
        },
      })
      .render('#paypal-button-container');
  }

  // Render verified payment receipt
  function showSuccessScreen(captureResult) {
    hideAlerts();
    checkoutSection.style.display = 'none';

    captureIdValEl.textContent = captureResult.captureId || 'N/A';
    orderIdValEl.textContent = captureResult.orderId || 'N/A';
    captureAmountValEl.textContent = `$${captureResult.amount} ${captureResult.currency}`;
    captureStatusValEl.textContent = captureResult.status;

    successScreen.style.display = 'block';
  }

  // Load and render transactions list and summary (Step 4)
  async function loadTransactions() {
    const summaryTotalVolumeEl = document.getElementById('summary-total-volume');
    const summaryTotalOrdersEl = document.getElementById('summary-total-orders');
    const summaryCompletedOrdersEl = document.getElementById('summary-completed-orders');
    const summaryPendingOrdersEl = document.getElementById('summary-pending-orders');
    const transactionsTbody = document.getElementById('transactions-tbody');
    const statusFilter = document.getElementById('transaction-status-filter')?.value || '';

    if (!transactionsTbody) return;

    try {
      // 1. Fetch monthly summary
      const summaryRes = await fetch('/api/transactions/summary');
      if (summaryRes.ok) {
        const summary = await summaryRes.json();
        if (summaryTotalVolumeEl) summaryTotalVolumeEl.textContent = `$${summary.totalVolume.toFixed(2)} USD`;
        if (summaryTotalOrdersEl) summaryTotalOrdersEl.textContent = summary.totalOrders;
        const completedCount = summary.countsByStatus?.COMPLETED || 0;
        const completedTotal = summary.totalsByStatus?.COMPLETED || 0;
        if (summaryCompletedOrdersEl) {
          summaryCompletedOrdersEl.textContent = `${completedCount} ($${completedTotal.toFixed(2)})`;
        }
        const pendingCount = summary.countsByStatus?.PENDING_APPROVAL || 0;
        const pendingTotal = summary.totalsByStatus?.PENDING_APPROVAL || 0;
        if (summaryPendingOrdersEl) {
          summaryPendingOrdersEl.textContent = `${pendingCount} ($${pendingTotal.toFixed(2)})`;
        }
      }

      // 2. Fetch transactions list
      const url = statusFilter
        ? `/api/transactions?status=${encodeURIComponent(statusFilter)}`
        : '/api/transactions';
      const listRes = await fetch(url);
      if (listRes.ok) {
        const list = await listRes.json();
        if (list.length === 0) {
          transactionsTbody.innerHTML =
            '<tr><td colspan="5" class="empty-cell">No transactions found.</td></tr>';
          return;
        }

        transactionsTbody.innerHTML = list
          .map((item) => {
            const dateStr = item.createdAt ? new Date(item.createdAt).toLocaleString() : 'N/A';
            const orderId = item.paypalOrderId || item.internalId || 'N/A';
            const captureId = item.captureId || '-';
            const amountStr = `$${Number(item.amount).toFixed(2)} ${item.currency}`;
            return `
              <tr>
                <td>${dateStr}</td>
                <td><span class="status-badge status-${item.status}">${item.status}</span></td>
                <td><strong>${amountStr}</strong></td>
                <td><code>${captureId}</code></td>
                <td><code>${orderId}</code></td>
              </tr>
            `;
          })
          .join('');
      }
    } catch (err) {
      console.error('[Transactions Load Error]', err);
    }
  }

  // Load and render pending approvals and audit logs (Step 5)
  async function loadGuardian() {
    const approvalsTbody = document.getElementById('approvals-tbody');
    const auditTbody = document.getElementById('audit-tbody');

    if (!approvalsTbody || !auditTbody) return;

    try {
      // 1. Fetch pending approvals
      const approvalsRes = await fetch('/api/approvals?status=PENDING');
      if (approvalsRes.ok) {
        const approvals = await approvalsRes.json();
        if (approvals.length === 0) {
          approvalsTbody.innerHTML =
            '<tr><td colspan="5" class="empty-cell">No pending approvals.</td></tr>';
        } else {
          approvalsTbody.innerHTML = approvals
            .map((req) => {
              const dateStr = req.createdAt ? new Date(req.createdAt).toLocaleTimeString() : 'N/A';
              const amountStr = `$${Number(req.amount).toFixed(2)} ${req.currency}`;
              return `
                <tr>
                  <td><code>${req.internalId.slice(0, 8)}...</code></td>
                  <td><strong>${amountStr}</strong></td>
                  <td title="${req.reason}">${req.reason}</td>
                  <td>${dateStr}</td>
                  <td>
                    <div class="btn-action-group">
                      <button type="button" class="btn-approve" data-id="${req.internalId}">Approve</button>
                      <button type="button" class="btn-reject" data-id="${req.internalId}">Reject</button>
                    </div>
                  </td>
                </tr>
              `;
            })
            .join('');

          // Wire click handlers for approve and reject buttons
          approvalsTbody.querySelectorAll('.btn-approve').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
              const id = e.target.getAttribute('data-id');
              await handleApprovalDecision(id, 'approve');
            });
          });

          approvalsTbody.querySelectorAll('.btn-reject').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
              const id = e.target.getAttribute('data-id');
              await handleApprovalDecision(id, 'reject');
            });
          });
        }
      }

      // 2. Fetch audit logs (newest first)
      const auditRes = await fetch('/api/audit?limit=25');
      if (auditRes.ok) {
        const logs = await auditRes.json();
        if (logs.length === 0) {
          auditTbody.innerHTML =
            '<tr><td colspan="5" class="empty-cell">No audit log entries recorded.</td></tr>';
        } else {
          auditTbody.innerHTML = logs
            .map((log) => {
              const dateStr = log.createdAt ? new Date(log.createdAt).toLocaleString() : 'N/A';
              const detailsStr = log.details ? JSON.stringify(log.details) : '';
              return `
                <tr>
                  <td>${dateStr}</td>
                  <td><strong>${log.action}</strong></td>
                  <td><code>${log.actor}</code></td>
                  <td><code>${log.entityId}</code></td>
                  <td title="${detailsStr}"><small>${detailsStr.slice(0, 60)}${detailsStr.length > 60 ? '...' : ''}</small></td>
                </tr>
              `;
            })
            .join('');
        }
      }
    } catch (err) {
      console.error('[Guardian Load Error]', err);
    }
  }

  async function handleApprovalDecision(requestId, action) {
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(requestId)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decidedBy: 'admin@paypilot.internal' }),
      });

      if (!res.ok) {
        const errData = await res.json();
        alert(`Failed to ${action} request: ${errData.error?.message || res.statusText}`);
      } else if (action === 'approve') {
        const approvedData = await res.json();
        if (
          pendingApprovalInfo &&
          (pendingApprovalInfo.approvalRequestId === requestId ||
            pendingApprovalInfo.orderInternalId === approvedData.orderInternalId)
        ) {
          pendingApprovalInfo.approvalRequestId = requestId;
          pendingApprovalInfo.orderInternalId =
            approvedData.orderInternalId || pendingApprovalInfo.orderInternalId;
        } else {
          pendingApprovalInfo = {
            approvalRequestId: requestId,
            orderInternalId: approvedData.orderInternalId,
            quantity: parseInt(quantitySelect.value, 10),
          };
        }
        showApprovalMessage(
          'Order approved by administrator! Click the PayPal button above to complete checkout.'
        );
      } else if (action === 'reject') {
        pendingApprovalInfo = null;
        showErrorMessage('Order approval was rejected by administrator.');
      }

      await loadGuardian();
      await loadTransactions();
    } catch (err) {
      console.error(`[Approval ${action} error]`, err);
    }
  }

  // Load and render FraudShield risk assessments (Phase 7)
  async function loadRiskAssessments() {
    const riskTotalAssessedEl = document.getElementById('risk-total-assessed');
    const riskLowCountEl = document.getElementById('risk-low-count');
    const riskModerateCountEl = document.getElementById('risk-moderate-count');
    const riskHighCountEl = document.getElementById('risk-high-count');
    const riskTbody = document.getElementById('risk-tbody');

    if (!riskTbody) return;

    try {
      // 1. Fetch risk summary
      const summaryRes = await fetch('/api/risk/summary');
      if (summaryRes.ok) {
        const summary = await summaryRes.json();
        if (riskTotalAssessedEl) riskTotalAssessedEl.textContent = summary.totalAssessed;
        if (riskLowCountEl) riskLowCountEl.textContent = summary.countsByClassification?.LOW || 0;
        if (riskModerateCountEl) riskModerateCountEl.textContent = summary.countsByClassification?.MODERATE || 0;
        const highAndCrit =
          (summary.countsByClassification?.HIGH || 0) +
          (summary.countsByClassification?.CRITICAL || 0);
        if (riskHighCountEl) riskHighCountEl.textContent = highAndCrit;
      }

      // 2. Fetch assessments list
      const listRes = await fetch('/api/risk/assessments');
      if (listRes.ok) {
        const list = await listRes.json();
        if (list.length === 0) {
          riskTbody.innerHTML =
            '<tr><td colspan="6" class="empty-cell">No risk assessments recorded yet.</td></tr>';
          return;
        }

        riskTbody.innerHTML = list
          .map((item) => {
            const dateStr = item.assessedAt ? new Date(item.assessedAt).toLocaleTimeString() : 'N/A';
            const reasonsStr =
              item.reasons && item.reasons.length > 0
                ? item.reasons.map((r) => r.rule).join(', ')
                : 'None (Clean)';
            return `
              <tr>
                <td><code>${item.orderInternalId.slice(0, 8)}...</code></td>
                <td><strong>${item.score}/100</strong></td>
                <td><span class="status-badge status-${item.classification}">${item.classification}</span></td>
                <td><small>${reasonsStr}</small></td>
                <td><code>${item.recommendedAction}</code></td>
                <td>${dateStr}</td>
              </tr>
            `;
          })
          .join('');
      }
    } catch (err) {
      console.error('[Risk Load Error]', err);
    }
  }

  // Load and render FreelancerPay clients & invoices (Phase 7)
  async function loadFreelancerData() {
    const clientSelect = document.getElementById('invoice-client-select');
    const invoicesTbody = document.getElementById('invoices-tbody');

    try {
      // 1. Fetch clients for dropdown
      const clientsRes = await fetch('/api/clients');
      if (clientsRes.ok && clientSelect) {
        const clients = await clientsRes.json();
        clientSelect.innerHTML = '<option value="">Select Client...</option>';
        clients.forEach((c) => {
          const opt = document.createElement('option');
          opt.value = c._id;
          opt.textContent = `${c.name} (${c.email})`;
          clientSelect.appendChild(opt);
        });
      }

      // 2. Fetch invoices
      if (invoicesTbody) {
        const invoicesRes = await fetch('/api/invoices');
        if (invoicesRes.ok) {
          const invoices = await invoicesRes.json();
          if (invoices.length === 0) {
            invoicesTbody.innerHTML =
              '<tr><td colspan="7" class="empty-cell">No invoices created yet.</td></tr>';
            return;
          }

          invoicesTbody.innerHTML = invoices
            .map((inv) => {
              const dueDateStr = inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : 'N/A';
              const paypalId = inv.paypalInvoiceId ? `<code>${inv.paypalInvoiceId}</code>` : '-';
              const sendBtn =
                inv.status === 'DRAFT'
                  ? `<button type="button" class="btn-approve btn-send-invoice" data-id="${inv.internalId}">Send</button>`
                  : '-';
              return `
                <tr>
                  <td><code>${inv.internalId.slice(0, 8)}...</code></td>
                  <td>${inv.clientId.slice(0, 8)}...</td>
                  <td><strong>$${Number(inv.total).toFixed(2)} ${inv.currency}</strong></td>
                  <td>${dueDateStr}</td>
                  <td><span class="status-badge status-${inv.status}">${inv.status}</span></td>
                  <td>${paypalId}</td>
                  <td>${sendBtn}</td>
                </tr>
              `;
            })
            .join('');

          // Wire Send invoice handlers
          invoicesTbody.querySelectorAll('.btn-send-invoice').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
              const id = e.target.getAttribute('data-id');
              try {
                const res = await fetch(`/api/invoices/${encodeURIComponent(id)}/send`, {
                  method: 'POST',
                });
                const data = await res.json();
                if (!res.ok) {
                  alert(`Cannot send invoice: ${data.error?.message || res.statusText}`);
                } else {
                  alert(`Invoice marked SENT successfully!`);
                }
                await loadFreelancerData();
                await loadGuardian();
              } catch (err) {
                console.error('[Send Invoice Error]', err);
              }
            });
          });
        }
      }
    } catch (err) {
      console.error('[Freelancer Data Load Error]', err);
    }
  }

  // Dashboard refresh controls
  const btnRefreshTransactions = document.getElementById('btn-refresh-transactions');
  if (btnRefreshTransactions) {
    btnRefreshTransactions.addEventListener('click', () => loadTransactions());
  }

  const transactionStatusFilter = document.getElementById('transaction-status-filter');
  if (transactionStatusFilter) {
    transactionStatusFilter.addEventListener('change', () => loadTransactions());
  }

  const btnRefreshGuardian = document.getElementById('btn-refresh-guardian');
  if (btnRefreshGuardian) {
    btnRefreshGuardian.addEventListener('click', () => loadGuardian());
  }

  const btnRefreshRisk = document.getElementById('btn-refresh-risk');
  if (btnRefreshRisk) {
    btnRefreshRisk.addEventListener('click', () => loadRiskAssessments());
  }

  const btnRefreshFreelancer = document.getElementById('btn-refresh-freelancer');
  if (btnRefreshFreelancer) {
    btnRefreshFreelancer.addEventListener('click', () => loadFreelancerData());
  }

  // Forms
  const formAddClient = document.getElementById('form-add-client');
  if (formAddClient) {
    formAddClient.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('client-name-input').value;
      const email = document.getElementById('client-email-input').value;
      const company = document.getElementById('client-company-input').value;

      try {
        const res = await fetch('/api/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, company: company || undefined }),
        });

        if (!res.ok) {
          const err = await res.json();
          alert(`Failed to add client: ${err.error?.message || res.statusText}`);
          return;
        }

        formAddClient.reset();
        await loadFreelancerData();
      } catch (err) {
        console.error('[Add Client Error]', err);
      }
    });
  }

  const formCreateInvoice = document.getElementById('form-create-invoice');
  if (formCreateInvoice) {
    formCreateInvoice.addEventListener('submit', async (e) => {
      e.preventDefault();
      const clientId = document.getElementById('invoice-client-select').value;
      const dueDate = document.getElementById('invoice-due-date').value;
      const description = document.getElementById('invoice-item-desc').value;
      const quantity = parseInt(document.getElementById('invoice-item-qty').value, 10);
      const unitPrice = parseFloat(document.getElementById('invoice-item-price').value);

      try {
        const res = await fetch('/api/invoices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId,
            dueDate: new Date(dueDate).toISOString(),
            items: [{ description, quantity, unitPrice }],
          }),
        });

        const data = await res.json();
        if (res.status === 202) {
          alert(`Invoice created (DRAFT), but requires Guardian administrator approval ($${data.invoice.total.toFixed(2)} > threshold).`);
        } else if (!res.ok) {
          alert(`Failed to create invoice: ${data.error?.message || res.statusText}`);
          return;
        }

        formCreateInvoice.reset();
        await loadFreelancerData();
        await loadGuardian();
      } catch (err) {
        console.error('[Create Invoice Error]', err);
      }
    });
  }

  // --- AI Assistant Integration ---
  const assistantForm = document.getElementById('assistant-form');
  const assistantInput = document.getElementById('assistant-input');
  const assistantSubmitBtn = document.getElementById('assistant-submit-btn');
  const assistantLoading = document.getElementById('assistant-loading');
  const assistantResponseCard = document.getElementById('assistant-response-card');
  const assistantResponseTitle = document.getElementById('assistant-response-title');
  const assistantToolTag = document.getElementById('assistant-tool-tag');
  const assistantReplyText = document.getElementById('assistant-reply-text');
  const assistantStructuredResult = document.getElementById('assistant-structured-result');
  const promptButtons = document.querySelectorAll('.prompt-btn');

  promptButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.getAttribute('data-prompt');
      if (prompt && assistantInput) {
        assistantInput.value = prompt;
        sendAssistantMessage(prompt);
      }
    });
  });

  if (assistantForm) {
    assistantForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const message = assistantInput ? assistantInput.value.trim() : '';
      if (message) {
        sendAssistantMessage(message);
      }
    });
  }

  async function sendAssistantMessage(message) {
    if (!message) return;

    if (assistantLoading) assistantLoading.style.display = 'flex';
    if (assistantResponseCard) assistantResponseCard.style.display = 'none';
    if (assistantSubmitBtn) assistantSubmitBtn.disabled = true;
    if (assistantInput) assistantInput.disabled = true;

    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });

      const data = await res.json();
      renderAssistantResponse(data);
    } catch (err) {
      console.error('[Assistant Error]', err);
      renderAssistantResponse({
        reply: 'Failed to communicate with AI Assistant service. Please try again.',
        needsClarification: true,
      });
    } finally {
      if (assistantLoading) assistantLoading.style.display = 'none';
      if (assistantSubmitBtn) assistantSubmitBtn.disabled = false;
      if (assistantInput) {
        assistantInput.disabled = false;
        assistantInput.focus();
      }
    }
  }

  function renderAssistantResponse(data) {
    if (!assistantResponseCard) return;

    assistantResponseCard.style.display = 'block';

    if (data.refused) {
      assistantResponseCard.style.borderLeft = '4px solid #ef4444';
      assistantResponseCard.style.backgroundColor = '#fef2f2';
      assistantResponseTitle.textContent = 'Action Refused (Security Policy)';
      assistantResponseTitle.style.color = '#b91c1c';
      assistantToolTag.style.display = 'none';
      assistantStructuredResult.style.display = 'none';
    } else if (data.needsClarification) {
      assistantResponseCard.style.borderLeft = '4px solid #f59e0b';
      assistantResponseCard.style.backgroundColor = '#fffbeb';
      assistantResponseTitle.textContent = 'Clarification Needed';
      assistantResponseTitle.style.color = '#b45309';
      assistantToolTag.style.display = 'none';
      assistantStructuredResult.style.display = 'none';
    } else {
      assistantResponseCard.style.borderLeft = '4px solid #2563eb';
      assistantResponseCard.style.backgroundColor = '#ffffff';
      assistantResponseTitle.textContent = 'Assistant Response';
      assistantResponseTitle.style.color = '#1e3a8a';

      if (data.toolUsed) {
        assistantToolTag.textContent = `Tool: ${data.toolUsed}`;
        assistantToolTag.style.display = 'inline-block';
      } else {
        assistantToolTag.style.display = 'none';
      }

      renderStructuredResult(data.toolUsed, data.result);
    }

    assistantReplyText.textContent = data.reply || '';
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderStructuredResult(toolName, result) {
    if (!assistantStructuredResult) return;

    if (!result || !toolName) {
      assistantStructuredResult.style.display = 'none';
      return;
    }

    let html = '';

    if (toolName === 'getTransactionSummary') {
      const month = result.month ? String(result.month) : '-';
      const totalOrders = (result.totalOrders !== undefined && result.totalOrders !== null && !isNaN(result.totalOrders))
        ? result.totalOrders
        : 0;
      const totalVolNum = (result.totalVolume !== undefined && result.totalVolume !== null) ? Number(result.totalVolume) : 0;
      const totalVolume = !isNaN(totalVolNum) ? totalVolNum.toFixed(2) : '0.00';

      const completedOrders = (result.countsByStatus && result.countsByStatus.COMPLETED !== undefined && !isNaN(result.countsByStatus.COMPLETED))
        ? result.countsByStatus.COMPLETED
        : 0;
      const compVolNum = (result.totalsByStatus && result.totalsByStatus.COMPLETED !== undefined)
        ? Number(result.totalsByStatus.COMPLETED)
        : 0;
      const completedVolume = !isNaN(compVolNum) ? compVolNum.toFixed(2) : '0.00';

      html = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px;">
          <div><strong>Month:</strong> ${escapeHtml(month)}</div>
          <div><strong>Total Orders:</strong> ${totalOrders}</div>
          <div><strong>Total Volume:</strong> $${totalVolume}</div>
          <div><strong>Completed Orders:</strong> ${completedOrders}</div>
          <div><strong>Completed Volume:</strong> $${completedVolume}</div>
        </div>
      `;
    } else if (toolName === 'getRiskSummary') {
      const totalAssessed = (result.totalAssessed !== undefined && result.totalAssessed !== null && !isNaN(result.totalAssessed))
        ? result.totalAssessed
        : 0;
      const c = result.countsByClassification || {};
      html = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px;">
          <div><strong>Total Assessed:</strong> ${totalAssessed}</div>
          <div style="color: #16a34a;"><strong>LOW:</strong> ${c.LOW ?? 0}</div>
          <div style="color: #d97706;"><strong>MODERATE:</strong> ${c.MODERATE ?? 0}</div>
          <div style="color: #dc2626;"><strong>HIGH:</strong> ${c.HIGH ?? 0}</div>
          <div style="color: #7f1d1d;"><strong>CRITICAL:</strong> ${c.CRITICAL ?? 0}</div>
        </div>
      `;
    } else if (toolName === 'listPendingApprovals') {
      if (Array.isArray(result) && result.length > 0) {
        html = '<ul style="margin: 0; padding-left: 20px;">' +
          result.map(r => {
            const amt = (r.amount !== undefined && !isNaN(Number(r.amount))) ? Number(r.amount).toFixed(2) : '0.00';
            const status = r.status || '-';
            const reason = escapeHtml(r.reason || 'No reason specified');
            const id = escapeHtml(r.internalId || '-');
            return `<li><strong>$${amt}</strong> (${status}): ${reason} [ID: ${id}]</li>`;
          }).join('') +
          '</ul>';
      } else {
        html = '<em>No pending approval requests.</em>';
      }
    } else if (toolName === 'createInvoiceDraft') {
      const inv = result.invoice;
      const statusBadge = result.status === 'approval_required'
        ? '<span style="color: #d97706; font-weight: bold;">Approval Required (Held in Guardian)</span>'
        : '<span style="color: #16a34a; font-weight: bold;">Created (DRAFT)</span>';
      const invTotal = (inv?.total !== undefined && !isNaN(Number(inv?.total))) ? Number(inv.total).toFixed(2) : '0.00';
      const invCurrency = escapeHtml(inv?.currency || 'USD');
      const invId = escapeHtml(inv?.internalId || '-');
      html = `
        <div><strong>Status:</strong> ${statusBadge}</div>
        <div><strong>Invoice ID:</strong> ${invId}</div>
        <div><strong>Total:</strong> $${invTotal} ${invCurrency}</div>
        ${result.approvalRequestId ? `<div><strong>Approval Request ID:</strong> ${escapeHtml(result.approvalRequestId)}</div>` : ''}
      `;
      // Refresh views if write occurred
      loadFreelancerData();
      loadGuardian();
    } else if (toolName === 'listClients') {
      if (Array.isArray(result) && result.length > 0) {
        html = '<ul style="margin: 0; padding-left: 20px;">' +
          result.map(c => `<li><strong>${escapeHtml(c.name || 'Unnamed')}</strong> - ${escapeHtml(c.email || '-')}${c.company ? ` (${escapeHtml(c.company)})` : ''}</li>`).join('') +
          '</ul>';
      } else {
        html = '<em>No clients found.</em>';
      }
    } else if (toolName === 'listInvoices') {
      if (Array.isArray(result) && result.length > 0) {
        html = '<ul style="margin: 0; padding-left: 20px;">' +
          result.map(i => {
            const total = (i.total !== undefined && !isNaN(Number(i.total))) ? Number(i.total).toFixed(2) : '0.00';
            const status = escapeHtml(i.status || '-');
            const dueDate = i.dueDate ? new Date(i.dueDate).toLocaleDateString() : '-';
            const id = escapeHtml(i.internalId || '-');
            return `<li><strong>$${total}</strong> [${status}] - Due: ${dueDate} (ID: ${id})</li>`;
          }).join('') +
          '</ul>';
      } else {
        html = '<em>No invoices found matching criteria.</em>';
      }
    } else if (toolName === 'getRiskAssessment') {
      const score = (result.score !== undefined && !isNaN(result.score)) ? result.score : 0;
      const classification = escapeHtml(result.classification || '-');
      const action = escapeHtml(result.recommendedAction || '-');
      const orderId = escapeHtml(result.orderInternalId || '-');
      html = `
        <div><strong>Order ID:</strong> ${orderId}</div>
        <div><strong>Risk Score:</strong> ${score}/100 (<span style="font-weight: bold;">${classification}</span>)</div>
        <div><strong>Recommended Action:</strong> ${action}</div>
      `;
    } else {
      html = `<div><strong>Result:</strong> ${escapeHtml(JSON.stringify(result))}</div>`;
    }

    assistantStructuredResult.innerHTML = html;
    assistantStructuredResult.style.display = 'block';
  }

  // Initial load
  initApp();
  loadTransactions();
  loadGuardian();
  loadRiskAssessments();
  loadFreelancerData();
})();
