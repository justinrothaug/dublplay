import { useEffect, useState } from 'react';
import { wagersApi, gamesApi, stripeApi } from './api.js';
import { theme } from './theme.js';

let stripeInstance = null;

async function getStripe() {
  if (stripeInstance) return stripeInstance;
  const { loadStripe } = await import('@stripe/stripe-js');
  const config = await gamesApi('/stripe/config');
  stripeInstance = await loadStripe(config.publishableKey);
  return stripeInstance;
}

export default function PaymentScreen({ params, onBack }) {
  const { wagerId, amount, opponentName } = params || {};
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        const { clientSecret } = await wagersApi.pay(wagerId);
        if (!mounted) return;

        const stripe = await getStripe();
        if (!mounted) return;

        const paymentRequest = stripe.paymentRequest({
          country: 'US',
          currency: 'usd',
          total: { label: `Wager vs ${opponentName}`, amount },
          requestPayerName: true,
          requestPayerEmail: true,
        });

        const canMakePayment = await paymentRequest.canMakePayment();
        if (!canMakePayment || !canMakePayment.applePay) {
          if (mounted) {
            setError('Apple Pay is not available on this device. Please use Safari on an Apple device with Apple Pay set up.');
            setLoading(false);
          }
          return;
        }

        paymentRequest.on('paymentmethod', async (ev) => {
          const { error: confirmError, paymentIntent } = await stripe.confirmCardPayment(
            clientSecret,
            { payment_method: ev.paymentMethod.id },
            { handleActions: false }
          );
          if (confirmError) {
            ev.complete('fail');
            if (mounted) {
              setError(confirmError.message);
              setLoading(false);
            }
          } else if (paymentIntent.status === 'requires_action') {
            ev.complete('success');
            const { error: actionError } = await stripe.confirmCardPayment(clientSecret);
            if (actionError) {
              if (mounted) { setError(actionError.message); setLoading(false); }
            } else {
              if (mounted) {
                alert(`Payment Successful! $${(amount / 100).toFixed(2)} paid for wager vs ${opponentName}`);
                onBack();
              }
            }
          } else {
            ev.complete('success');
            if (mounted) {
              alert(`Payment Successful! $${(amount / 100).toFixed(2)} paid for wager vs ${opponentName}`);
              onBack();
            }
          }
        });

        paymentRequest.on('cancel', () => {
          if (mounted) onBack();
        });

        setLoading(false);
        paymentRequest.show();
      } catch (err) {
        if (mounted) {
          setError(err.message || 'Failed to initialize payment');
          setLoading(false);
        }
      }
    }

    init();
    return () => { mounted = false; };
  }, [wagerId]);

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
      {loading && (
        <div style={styles.loadingContainer}>
          <div style={styles.loadingText}>Opening Apple Pay...</div>
        </div>
      )}
      {error && (
        <div style={styles.errorContainer}>
          <div style={styles.errorText}>{error}</div>
          <button style={styles.backButton} onClick={onBack}>Go Back</button>
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
  errorContainer: { padding: 24, textAlign: 'center' },
  errorText: { color: theme.colors.danger || '#e53935', fontSize: 14, marginBottom: 16 },
  backButton: { background: theme.colors.primary, color: theme.colors.background, border: 'none', borderRadius: 8, padding: '12px 32px', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
};
