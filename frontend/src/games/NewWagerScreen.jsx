import { useEffect, useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { friendsApi, wagersApi } from './api.js';
import { theme } from './theme.js';

export default function NewWagerScreen({ params, onBack }) {
  const { user } = useAuth();
  const [friends, setFriends] = useState([]);
  const [selectedFriend, setSelectedFriend] = useState(null);
  const [amount, setAmount] = useState('');

  useEffect(() => {
    friendsApi.list().then((list) => {
      setFriends(list);
      const { friendId, friendName, friendUsername } = params || {};
      if (friendId) {
        const match = list.find((f) => f.id === friendId);
        if (match) {
          setSelectedFriend(match);
        } else {
          setSelectedFriend({ id: friendId, display_name: friendName, chess_com_username: friendUsername });
        }
      }
    }).catch(console.error);
  }, [params]);

  const handleCreateWager = async () => {
    if (!selectedFriend) { alert('Please select a friend'); return; }
    if (!amount || parseFloat(amount) <= 0) { alert('Please enter a valid wager amount'); return; }
    try {
      const amountCents = Math.round(parseFloat(amount) * 100);
      await wagersApi.create(selectedFriend.id, amountCents);
      alert(`$${amount} wager challenge sent to ${selectedFriend.display_name}`);
      onBack();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.modalHeader}>
        <span style={styles.modalTitle}>New Wager</span>
        <button style={styles.closeButton} onClick={onBack}>✕</button>
      </div>
      <div style={styles.content}>
        <div style={styles.label}>Select Friend</div>
        {friends.length > 0 ? (
          <div style={styles.friendList}>
            {friends.map((f) => (
              <button
                key={f.id}
                style={{
                  ...styles.friendChip,
                  ...(selectedFriend?.id === f.id ? styles.friendChipSelected : {}),
                }}
                onClick={() => setSelectedFriend(f)}
              >
                <span style={selectedFriend?.id === f.id ? styles.friendChipTextSelected : styles.friendChipText}>
                  {f.display_name}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div style={styles.emptyText}>No friends yet. Add friends first!</div>
        )}

        <div style={styles.label}>Wager Amount ($)</div>
        <input
          style={styles.input}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="5.00"
          type="number"
          step="0.01"
          min="0"
        />

        {selectedFriend && (
          <div style={styles.summary}>
            <div style={styles.summaryText}>
              <span style={styles.summaryHighlight}>{user?.chess_com_username || '???'}</span>
              {' vs '}
              <span style={styles.summaryHighlight}>{selectedFriend.chess_com_username}</span>
            </div>
            <div style={styles.summaryAmount}>
              ${amount ? parseFloat(amount).toFixed(2) : '0.00'}
            </div>
          </div>
        )}

        <button style={styles.createButton} onClick={handleCreateWager}>
          Send Challenge
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: { flex: 1, background: theme.colors.background, minHeight: '100%' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 16px 8px', background: theme.colors.surface, borderBottom: `1px solid ${theme.colors.border}` },
  modalTitle: { color: theme.colors.primary, fontSize: 18, fontWeight: 700 },
  closeButton: { width: 36, height: 36, borderRadius: 18, background: theme.colors.card, border: 'none', cursor: 'pointer', color: theme.colors.text, fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, paddingBottom: 100, maxWidth: 500, margin: '0 auto', width: '100%' },
  label: { color: theme.colors.textSecondary, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginTop: 24, marginBottom: 8 },
  input: { width: '100%', background: theme.colors.surface, borderRadius: 8, padding: 16, color: theme.colors.text, fontSize: 15, border: `1px solid ${theme.colors.border}`, outline: 'none', boxSizing: 'border-box', marginBottom: 8 },
  friendList: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  friendChip: { background: theme.colors.surface, borderRadius: 16, padding: '8px 16px', border: `1px solid ${theme.colors.border}`, cursor: 'pointer' },
  friendChipSelected: { background: theme.colors.primary, borderColor: theme.colors.primary },
  friendChipText: { color: theme.colors.text, fontSize: 15 },
  friendChipTextSelected: { color: theme.colors.background, fontWeight: 700, fontSize: 15 },
  emptyText: { color: theme.colors.textMuted, fontSize: 15 },
  summary: { background: theme.colors.surface, borderRadius: 12, padding: 24, marginTop: 24, textAlign: 'center', border: `1px solid ${theme.colors.primary}` },
  summaryText: { color: theme.colors.text, fontSize: 18 },
  summaryHighlight: { color: theme.colors.accent, fontWeight: 700 },
  summaryAmount: { color: theme.colors.primary, fontSize: 32, fontWeight: 800, marginTop: 8 },
  createButton: { width: '100%', background: theme.colors.primary, borderRadius: 8, padding: 16, border: 'none', cursor: 'pointer', color: theme.colors.background, fontSize: 18, fontWeight: 800, marginTop: 24 },
};
