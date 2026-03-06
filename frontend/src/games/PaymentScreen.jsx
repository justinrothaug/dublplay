import { useEffect, useState } from 'react';
import { wagersApi, gamesApi } from './api.js';
import { theme } from './theme.js';

let stripePromise = null;

async function getStripe() {
  if (!stripePromise) {
    const { loadStripe } = await import('@stripe/stripe-js');
    const config = await gamesApi('/stripe/config');
    stripePromise = loadStripe(config.publishableKey);
  }
  return stripePromise;
}

export default function PaymentScreen({ params, onBack }) {
  const { wagerId, amount, opponentName } = params || {};
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [stripe, setStripe] = useState(null);
  const [elements, setElements] = useState(null);
  const [paymentReady, setPaymentReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        const { clientSecret: cs } = await wagersApi.pay(wagerId);
        if (!mounted) return;

        const stripeInstance = await getStripe();
        if (!mounted) return;
        setStripe(stripeInstance);

        const elementsInstance = stripeInstance.elements({
          clientSecret: cs,
          appearance: {
            theme: 'night',
            variables: {
              colorPrimary: theme.colors.primary,
              colorBackground: theme.colors.surface,
              colorText: theme.colors.text,
              colorDanger: theme.colors.danger,
              borderRadius: '8px',
            },
          },
        });

        const paymentElement = elementsInstance.create('payment', {
          layout: 'tabs',
          wallets: { applePay: 'auto', googlePay: 'auto' },
        });

        setTimeout(() => {
          const container = document.getElementById('stripe-payment-element');
          if (container && mounted) {
            paymentElement.mount(container);
            paymentElement.on('ready', () => {
              if (mounted) setPaymentReady(true);
            });
            setElements(elementsInstance);
          }
        }, 100);

        setLoading(false);
      } catch (err) {
        if (mounted) {
          alert('Error: ' + (err.message || 'Failed to initialize payment'));
          onBack();
        }
      }
    }

    init();
    return () => { mounted = false; };
  }, [wagerId]);

  const handlePay = async () => {
    if (!stripe || !elements) return;
    setPaying(true);
    try {
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: window.location.origin },
        redirect: 'if_required',
      });
      if (error) {
        alert('Payment Failed: ' + error.message);
        setPaying(false);
      } else {
        alert(`Payment Successful! $${(amount / 100).toFixed(2)} paid for wager vs ${opponentName}`);
        onBack();
      }
    } catch (err) {
      alert('Error: ' + err.message);
      setPaying(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Pay for Wager</span>
        <button style={styles.closeButton} onClick={onBack}>✕</button>
      </div>
      <div style={styles.summaryCard}>
        <div style={styles.summaryLabel}>Wager vs {opponentName}</div>
        <div style={styles.summaryAmount}>${(amount / 100).toFixed(2)}</div>
      </div>
      {loading ? (
        <div style={styles.loadingContainer}>
          <div style={styles.loadingText}>Setting up payment...</div>
        </div>
      ) : (
        <div style={styles.paymentContainer}>
          <div id="stripe-payment-element" style={styles.stripeElement} />
          <button
            style={{ ...styles.payButton, ...(!paymentReady || paying ? styles.payButtonDisabled : {}) }}
            onClick={handlePay}
            disabled={!paymentReady || paying}
          >
            {paying ? 'Processing...' : `Pay $${(amount / 100).toFixed(2)}`}
          </button>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: { flex: 1, background: theme.colors.background, minHeight: '100%' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 16px 8px', background: theme.colors.surface, borderBottom: `1px solid ${theme.colors.border}` },
  title: { color: theme.colors.primary, fontSize: 18, fontWeight: 700 },
  closeButton: { width: 36, height: 36, borderRadius: 18, background: theme.colors.card, border: 'none', cursor: 'pointer', color: theme.colors.text, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  summaryCard: { background: theme.colors.surface, margin: 16, padding: 24, borderRadius: 12, textAlign: 'center', border: `1px solid ${theme.colors.border}` },
  summaryLabel: { color: theme.colors.textSecondary, fontSize: 15 },
  summaryAmount: { color: theme.colors.primary, fontSize: 32, fontWeight: 800, marginTop: 4 },
  loadingContainer: { display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 48 },
  loadingText: { color: theme.colors.textMuted, fontSize: 15 },
  paymentContainer: { padding: 16, maxWidth: 500, margin: '0 auto', width: '100%' },
  stripeElement: { minHeight: 300, marginBottom: 24 },
  payButton: { width: '100%', background: theme.colors.primary, borderRadius: 8, padding: 16, border: 'none', cursor: 'pointer', color: theme.colors.background, fontSize: 18, fontWeight: 800, textAlign: 'center' },
  payButtonDisabled: { opacity: 0.5, cursor: 'default' },
};
