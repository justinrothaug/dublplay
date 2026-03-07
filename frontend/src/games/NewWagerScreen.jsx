import { useEffect, useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { friendsApi, wagersApi } from './api.js';
import { PLATFORMS, getGameDisplayName, getPlatformDisplayName } from './gameConfig.js';
import { authApi } from './api.js';
import { theme } from './theme.js';

export default function NewWagerScreen({ params, onBack, onWalletRefresh, walletBalance }) {
  const { user, refreshUser } = useAuth();
  const [friends, setFriends] = useState([]);
  const [selectedFriend, setSelectedFriend] = useState(null);
  const [selectedPlatform, setSelectedPlatform] = useState(null);
  const [selectedGame, setSelectedGame] = useState(null);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState('friend'); // 'friend' | 'game' | 'amount'

  useEffect(() => {
    friendsApi.list().then((list) => {
      setFriends(list);
      const { friendId, friendName, friendUsername } = params || {};
      if (friendId) {
        const match = list.find((f) => f.id === friendId);
        if (match) {
          setSelectedFriend(match);
          setStep('game');
        } else {
          setSelectedFriend({ id: friendId, display_name: friendName, chess_com_username: friendUsername });
          setStep('game');
        }
      }
    }).catch(console.error);
  }, [params]);

  const handleSelectGame = async (platformId, game) => {
    if (platformId === 'bga' && !user?.bga_username) {
      const bgaName = prompt('Enter your Board Game Arena username to continue:');
      if (!bgaName?.trim()) return;
      try {
        await authApi.updatePlatformUsernames(null, bgaName.trim());
        await refreshUser();
      } catch (err) {
        alert('Error linking BGA: ' + err.message);
        return;
      }
    }
    setSelectedPlatform(platformId);
    setSelectedGame(game);
    setStep('amount');
  };

  const handleCreateWager = async () => {
    if (!selectedFriend) { alert('Please select a friend'); return; }
    if (!selectedPlatform || !selectedGame) { alert('Please select a game'); return; }
    if (!amount || parseFloat(amount) <= 0) { alert('Please enter a valid wager amount'); return; }
    try {
      const amountCents = Math.round(parseFloat(amount) * 100);
      await wagersApi.create(selectedFriend.id, amountCents, selectedPlatform, selectedGame.id);
      alert(`$${amount} ${selectedGame.name} wager sent to ${selectedFriend.display_name}. Funds deducted from your wallet.`);
      onWalletRefresh?.();
      onBack();
    } catch (err) {
      if (err.message?.includes('Insufficient balance')) {
        alert(`Insufficient funds! Your balance is $${walletBalance || '0.00'}. Please deposit more funds from the wallet.`);
      } else {
        alert('Error: ' + err.message);
      }
    }
  };

  const handleStepBack = () => {
    if (step === 'amount') { setStep('game'); setSelectedPlatform(null); setSelectedGame(null); }
    else if (step === 'game') {
      if (params?.friendId) { onBack(); }
      else { setStep('friend'); setSelectedFriend(null); }
    }
    else { onBack(); }
  };

  // Show all platforms — prompt for username during wager if not linked
  const getAvailablePlatforms = () => {
    return Object.values(PLATFORMS);
  };

  return (
    <div style={styles.container}>
      <div style={styles.modalHeader}>
        <button style={styles.backBtn} onClick={handleStepBack}>&#8592;</button>
        <span style={styles.modalTitle}>
          {step === 'friend' ? 'Select Friend' : step === 'game' ? 'Select Game' : 'Set Wager'}
        </span>
        <button style={styles.closeButton} onClick={onBack}>&#10005;</button>
      </div>
      <div style={styles.content}>

        {/* Step 1: Select Friend */}
        {step === 'friend' && (
          <>
            <div style={styles.label}>Who are you challenging?</div>
            {friends.length > 0 ? (
              <div style={styles.friendListVertical}>
                {friends.map((f) => (
                  <button
                    key={f.id}
                    style={styles.friendRow}
                    onClick={() => { setSelectedFriend(f); setStep('game'); }}
                  >
                    <div style={styles.friendAvatar}>
                      {(f.display_name || '?')[0].toUpperCase()}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={styles.friendName}>{f.display_name}</div>
                      <div style={styles.friendSub}>@{f.chess_com_username}</div>
                    </div>
                    <span style={{ color: theme.colors.primary, fontSize: 18 }}>&#8594;</span>
                  </button>
                ))}
              </div>
            ) : (
              <div style={styles.emptyText}>No friends yet. Add friends first!</div>
            )}
          </>
        )}

        {/* Step 2: Select Platform + Game */}
        {step === 'game' && selectedFriend && (
          <>
            <div style={styles.challengingBanner}>
              Challenging <span style={{ color: theme.colors.accent, fontWeight: 700 }}>{selectedFriend.display_name}</span>
            </div>
            {getAvailablePlatforms().map((platform) => (
              <div key={platform.id} style={styles.platformSection}>
                <div style={styles.platformHeader}>
                  <span style={{ fontSize: 18 }}>{platform.icon}</span>
                  <span style={styles.platformName}>{platform.name}</span>
                </div>
                <div style={styles.gameGrid}>
                  {platform.games.map((game) => (
                    <button
                      key={`${platform.id}-${game.id}`}
                      style={styles.gameCard}
                      onClick={() => handleSelectGame(platform.id, game)}
                    >
                      <span style={styles.gameIcon}>{game.icon}</span>
                      <span style={styles.gameName}>{game.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}

        {/* Step 3: Enter Amount */}
        {step === 'amount' && selectedFriend && selectedGame && (
          <>
            <div style={styles.selectedSummary}>
              <div style={styles.summaryRow}>
                <span style={{ color: theme.colors.textSecondary }}>Game</span>
                <span style={{ color: theme.colors.text, fontWeight: 700 }}>
                  {selectedGame.icon} {selectedGame.name}
                </span>
              </div>
              <div style={styles.summaryRow}>
                <span style={{ color: theme.colors.textSecondary }}>Platform</span>
                <span style={{ color: theme.colors.text, fontWeight: 600 }}>
                  {getPlatformDisplayName(selectedPlatform)}
                </span>
              </div>
              <div style={styles.summaryRow}>
                <span style={{ color: theme.colors.textSecondary }}>Opponent</span>
                <span style={{ color: theme.colors.accent, fontWeight: 700 }}>
                  {selectedFriend.display_name}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={styles.label}>Wager Amount ($)</div>
              <div style={{ fontSize: 13, color: theme.colors.textMuted, marginTop: 16 }}>
                Balance: <span style={{ color: theme.colors.success, fontWeight: 700 }}>${walletBalance || '0.00'}</span>
              </div>
            </div>
            <input
              style={styles.input}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="5.00"
              type="number"
              step="0.01"
              min="0"
              autoFocus
            />

            {amount && parseFloat(amount) > 0 && (
              <div style={styles.potDisplay}>
                <div style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Total Pot</div>
                <div style={{ color: theme.colors.primary, fontSize: 36, fontWeight: 800 }}>
                  ${(parseFloat(amount) * 2).toFixed(2)}
                </div>
              </div>
            )}

            <button style={styles.createButton} onClick={handleCreateWager}>
              Send Challenge
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: { flex: 1, background: theme.colors.background, minHeight: '100%' },
  modalHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '16px 16px 8px', background: theme.colors.surface,
    borderBottom: `1px solid ${theme.colors.border}`,
  },
  modalTitle: { color: theme.colors.primary, fontSize: 18, fontWeight: 700 },
  backBtn: {
    width: 36, height: 36, borderRadius: 18, background: theme.colors.card,
    border: 'none', cursor: 'pointer', color: theme.colors.text, fontSize: 18,
    fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  closeButton: {
    width: 36, height: 36, borderRadius: 18, background: theme.colors.card,
    border: 'none', cursor: 'pointer', color: theme.colors.text, fontSize: 18,
    fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  content: { padding: 16, paddingBottom: 100, maxWidth: 500, margin: '0 auto', width: '100%' },
  label: {
    color: theme.colors.textSecondary, fontSize: 13, fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: 1, marginTop: 16, marginBottom: 8,
  },
  input: {
    width: '100%', background: theme.colors.surface, borderRadius: 8, padding: 16,
    color: theme.colors.text, fontSize: 24, fontWeight: 700, textAlign: 'center',
    border: `1px solid ${theme.colors.border}`, outline: 'none', boxSizing: 'border-box',
  },
  // Friend selection
  friendListVertical: { display: 'flex', flexDirection: 'column', gap: 8 },
  friendRow: {
    display: 'flex', alignItems: 'center', gap: 12, padding: 14,
    background: theme.colors.card, borderRadius: 12,
    border: `1px solid ${theme.colors.border}`, cursor: 'pointer',
    textAlign: 'left', width: '100%',
  },
  friendAvatar: {
    width: 40, height: 40, borderRadius: '50%', background: theme.colors.primary,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#fff', fontWeight: 800, fontSize: 16, flexShrink: 0,
  },
  friendName: { color: theme.colors.text, fontSize: 15, fontWeight: 600 },
  friendSub: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 1 },
  emptyText: { color: theme.colors.textMuted, fontSize: 15, textAlign: 'center', padding: 16 },
  // Game selection
  challengingBanner: {
    textAlign: 'center', padding: 12, fontSize: 15, color: theme.colors.textSecondary,
    background: theme.colors.surface, borderRadius: 10, marginBottom: 16,
    border: `1px solid ${theme.colors.border}`,
  },
  platformSection: { marginBottom: 20 },
  platformHeader: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
    paddingBottom: 6, borderBottom: `1px solid ${theme.colors.border}`,
  },
  platformName: { color: theme.colors.text, fontSize: 16, fontWeight: 700 },
  gameGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
  },
  gameCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 4, padding: '14px 6px', background: theme.colors.card, borderRadius: 10,
    border: `1px solid ${theme.colors.border}`, cursor: 'pointer',
  },
  gameIcon: { fontSize: 24 },
  gameName: { fontSize: 11, fontWeight: 600, color: theme.colors.text, textAlign: 'center' },
  // Amount step
  selectedSummary: {
    background: theme.colors.surface, borderRadius: 12, padding: 16, marginBottom: 16,
    border: `1px solid ${theme.colors.border}`,
  },
  summaryRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '6px 0', fontSize: 14,
  },
  potDisplay: { textAlign: 'center', marginTop: 16, marginBottom: 8 },
  createButton: {
    width: '100%', background: theme.colors.primary, borderRadius: 8, padding: 16,
    border: 'none', cursor: 'pointer', color: theme.colors.background,
    fontSize: 18, fontWeight: 800, marginTop: 20,
  },
};
