import { useState } from 'react';
import { wagersApi } from './api.js';
import { theme } from './theme.js';

export default function PaymentScreen({ params, onBack }) {
  const { wagerId, amount, opponentName } = params || {};
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handlePay = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await wagersApi.pay(wagerId);
      alert(`Payment Successful! $${(amount / 100).toFixed(2)} deducted from your wallet. New balance: $${(result.newBalanceCents / 100).toFixed(2)}`);
      onBack();
    } catch (err) {
      setError(err.message || 'Payment failed');
      setLoading(false);
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
        <div style={styles.summaryNote}>Deducted from your wallet balance</div>
      </div>
      {error && (
        <div style={styles.errorContainer}>
          <div style={styles.errorText}>{error}</div>
        </div>
      )}
      <div style={styles.buttonContainer}>
        <button style={styles.payButton} onClick={handlePay} disabled={loading}>
          {loading ? 'Processing...' : `PAY $${(amount / 100).toFixed(2)}`}
        </button>
        <button style={styles.cancelButton} onClick={onBack} disabled={loading}>Cancel</button>
      </div>
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
  summaryNote: { color: theme.colors.textMuted, fontSize: 13, marginTop: 8 },
  buttonContainer: { padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 },
  payButton: { background: theme.colors.primary, color: theme.colors.background, border: 'none', borderRadius: 8, padding: '14px 32px', fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  cancelButton: { background: 'transparent', color: theme.colors.textMuted, border: `1px solid ${theme.colors.border}`, borderRadius: 8, padding: '12px 32px', fontSize: 15, cursor: 'pointer' },
  errorContainer: { padding: '0 16px 16px', textAlign: 'center' },
  errorText: { color: theme.colors.danger || '#e53935', fontSize: 14 },
};
