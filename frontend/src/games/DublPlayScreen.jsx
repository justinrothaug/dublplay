import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { friendsApi, wagersApi } from './api.js';
import { getGameDisplayName, getPlatformDisplayName, getPlatformUrl, getBgaSlug } from './gameConfig.js';
import { theme } from './theme.js';

export default function DublPlayScreen({ onNavigate, onWalletRefresh }) {
  const { user } = useAuth();
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]);
  const [wagers, setWagers] = useState([]);
  const [username, setUsername] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [f, r, w] = await Promise.all([
        friendsApi.list(),
        friendsApi.requests(),
        wagersApi.list(),
      ]);
      setFriends(f);
      setRequests(r);
      setWagers(w.filter(x => x.status !== 'cancelled' && x.status !== 'declined'));
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    onWalletRefresh?.();
    setRefreshing(false);
  };

  const handleSendRequest = async () => {
    if (!username.trim()) return;
    try {
      await friendsApi.sendRequest(username.trim());
      alert(`Friend request sent to ${username}`);
      setUsername('');
      loadData();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  const handleAcceptFriend = async (id) => {
    try { await friendsApi.accept(id); loadData(); } catch (err) { alert('Error: ' + err.message); }
  };
  const handleDeclineFriend = async (id) => {
    try { await friendsApi.decline(id); loadData(); } catch (err) { alert('Error: ' + err.message); }
  };
  const handleAcceptWager = async (id) => {
    try { await wagersApi.accept(id); loadData(); onWalletRefresh?.(); } catch (err) { alert('Error: ' + err.message); }
  };
  const handleDeclineWager = async (id) => {
    try { await wagersApi.decline(id); loadData(); onWalletRefresh?.(); } catch (err) { alert('Error: ' + err.message); }
  };
  const handleCancelWager = async (id) => {
    try { await wagersApi.cancel(id); loadData(); onWalletRefresh?.(); } catch (err) { alert('Error: ' + err.message); }
  };

  const handleChallengeFriend = (friend) => {
    onNavigate('newWager', { friendId: friend.id, friendName: friend.display_name, friendUsername: friend.chess_com_username });
  };

  const getOpponentPlatformUsername = (w) =>
    w.challengerId === user?.id ? w.opponent_platform_username : w.challenger_platform_username;

  const getChallengeUrl = (wager) => {
    const opponentUsername = getOpponentPlatformUsername(wager);
    const platform = wager.platform || 'chesscom';
    const isChallenger = wager.challengerId === user?.id;
    if (platform === 'chesscom' && opponentUsername) {
      const color = isChallenger ? 'white' : 'black';
      return `https://www.chess.com/play/online#time=10m0s0i&game=chess&rated=rated&color=${color}&member=${opponentUsername}`;
    }
    if (platform === 'bga') {
      const slug = getBgaSlug(wager.gameType);
      if (slug) return `https://boardgamearena.com/gamepanel?game=${slug}`;
      return 'https://boardgamearena.com';
    }
    return getPlatformUrl(platform);
  };

  const getBgaFriendUrl = (wager) => {
    const opponentUsername = getOpponentPlatformUsername(wager);
    if (opponentUsername) return `https://boardgamearena.com/player?name=${opponentUsername}`;
    return null;
  };

  const openUrl = async (url) => {
    if (typeof window !== 'undefined' && window.Capacitor) {
      try {
        const { Browser } = window.Capacitor.Plugins;
        await Browser.open({ url, presentationStyle: 'fullscreen' });
      } catch { window.open(url, '_blank'); }
    } else {
      window.open(url, '_blank');
    }
  };

  const getOpponentName = (w) =>
    w.challengerId === user?.id ? w.opponent_name : w.challenger_name;

  const getStatusDisplay = (w) => {
    if (w.status === 'settled' && w.result) {
      const iWon = w.winnerId === user?.id;
      const isDraw = w.result === 'draw';
      if (isDraw) return { label: 'DRAW', color: theme.colors.draw };
      return iWon
        ? { label: 'WIN', color: theme.colors.success }
        : { label: 'LOSS', color: theme.colors.danger };
    }
    const labels = { pending_acceptance: 'PENDING', active: 'ACTIVE', both_paid: 'PLAYING' };
    return { label: labels[w.status] || w.status.toUpperCase(), color: theme.colors.primary };
  };

  const isPendingForMe = (w) =>
    w.status === 'pending_acceptance' && w.opponentId === user?.id;
  const isSentByMe = (w) =>
    w.status === 'pending_acceptance' && w.challengerId === user?.id;

  return (
    <div style={styles.container}>
      <div style={styles.list}>
        <div style={styles.sectionTitle}>Add Friend</div>
        <div style={styles.addRow}>
          <input
            style={styles.input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Display name or Chess.com username"
            onKeyDown={(e) => e.key === 'Enter' && handleSendRequest()}
          />
          <button style={styles.sendButton} onClick={handleSendRequest}>Send</button>
        </div>

        {requests.length > 0 && (
          <>
            <div style={styles.sectionTitle}>Pending Requests</div>
            {requests.map((r) => (
              <div key={r.friendship_id} style={styles.requestRow}>
                <div style={{ flex: 1 }}>
                  <div style={styles.friendName}>{r.display_name}</div>
                  <div style={styles.friendUsername}>@{r.chess_com_username}</div>
                </div>
                {r.direction === 'outgoing' ? (
                  <span style={styles.pendingBadge}>Pending</span>
                ) : (
                  <>
                    <button style={styles.acceptButton} onClick={() => handleAcceptFriend(r.friendship_id)}>Accept</button>
                    <button style={styles.declineButton} onClick={() => handleDeclineFriend(r.friendship_id)}>Decline</button>
                  </>
                )}
              </div>
            ))}
          </>
        )}

        <div style={styles.sectionTitle}>Friends</div>
        {friends.length === 0 ? (
          <div style={styles.emptyText}>No friends yet. Add someone by their display name!</div>
        ) : (
          friends.map((item) => (
            <div key={item.friendship_id} style={styles.friendRow} onClick={() => handleChallengeFriend(item)}>
              <div style={{ flex: 1 }}>
                <div style={styles.friendName}>{item.display_name}</div>
                <div style={styles.friendUsername}>@{item.chess_com_username}</div>
              </div>
              <span style={styles.challengeIcon}>⚔</span>
            </div>
          ))
        )}

        {wagers.length > 0 && (
          <>
            <div style={styles.sectionTitle}>Wagers</div>
            {wagers.map((item) => {
              const statusInfo = getStatusDisplay(item);
              const pending = isPendingForMe(item);
              return (
                <div key={item.id} style={styles.wagerCard}>
                  <div style={styles.wagerHeader}>
                    <span style={styles.wagerFriend}>{getOpponentName(item)}</span>
                    <span style={styles.wagerAmount}>${(item.amountCents / 100).toFixed(2)}</span>
                  </div>
                  <div style={styles.wagerPlayers}>
                    {item.gameType
                      ? `${getGameDisplayName(item.platform, item.gameType)} on ${getPlatformDisplayName(item.platform || 'chesscom')}`
                      : `${item.challenger_chess_username} vs ${item.opponent_chess_username}`
                    }
                  </div>
                  {pending ? (
                    <div style={styles.actionRow}>
                      <button style={styles.acceptButton} onClick={() => handleAcceptWager(item.id)}>Accept</button>
                      <button style={styles.declineButton} onClick={() => handleDeclineWager(item.id)}>Decline</button>
                    </div>
                  ) : isSentByMe(item) ? (
                    <div style={styles.actionRow}>
                      <span style={{ ...styles.badge, border: `1px solid ${theme.colors.textMuted}`, color: theme.colors.textMuted }}>SENT</span>
                      <button style={styles.declineButton} onClick={() => handleCancelWager(item.id)}>Cancel</button>
                    </div>
                  ) : item.cancelRequestedBy && item.cancelRequestedBy !== user?.id ? (
                    <div style={styles.actionRow}>
                      <span style={{ ...styles.badge, border: `1px solid ${theme.colors.textMuted}`, color: theme.colors.textMuted }}>CANCEL REQUESTED</span>
                      <button style={styles.acceptButton} onClick={() => handleCancelWager(item.id)}>Accept Cancel</button>
                    </div>
                  ) : item.cancelRequestedBy === user?.id ? (
                    <div style={styles.actionRow}>
                      <span style={{ ...styles.badge, border: `1px solid ${theme.colors.textMuted}`, color: theme.colors.textMuted }}>CANCEL PENDING</span>
                    </div>
                  ) : ['active', 'both_paid'].includes(item.status) ? (
                    <div style={styles.actionRow}>
                      {(item.platform || 'chesscom') === 'bga' && getBgaFriendUrl(item) && (
                        <button style={styles.addFriendButton} onClick={() => openUrl(getBgaFriendUrl(item))}>
                          Add on BGA
                        </button>
                      )}
                      <button style={styles.playNowButton} onClick={() => openUrl(getChallengeUrl(item))}>
                        Play Now
                      </button>
                      <button style={styles.declineButton} onClick={() => handleCancelWager(item.id)}>Cancel</button>
                    </div>
                  ) : (
                    <span style={{
                      ...styles.badge,
                      ...(item.status === 'settled'
                        ? { background: statusInfo.color, color: '#fff' }
                        : { border: `1px solid ${statusInfo.color}`, color: statusInfo.color }),
                    }}>
                      {statusInfo.label}
                    </span>
                  )}
                </div>
              );
            })}
          </>
        )}

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button style={styles.refreshBtn} onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: { flex: 1, background: theme.colors.background, minHeight: '100%' },
  list: { padding: 16, paddingBottom: 100, maxWidth: 600, margin: '0 auto' },
  sectionTitle: { fontSize: 18, fontWeight: 700, color: theme.colors.primary, marginTop: 24, marginBottom: 8 },
  addRow: { display: 'flex', gap: 8 },
  input: { flex: 1, background: theme.colors.surface, borderRadius: 8, padding: 16, color: theme.colors.text, fontSize: 15, border: `1px solid ${theme.colors.border}`, outline: 'none' },
  sendButton: { background: theme.colors.primary, borderRadius: 8, padding: '0 24px', border: 'none', cursor: 'pointer', color: theme.colors.background, fontWeight: 700, fontSize: 15 },
  friendRow: { display: 'flex', alignItems: 'center', background: theme.colors.card, borderRadius: 12, padding: 16, marginBottom: 8, border: `1px solid ${theme.colors.border}`, cursor: 'pointer' },
  friendName: { color: theme.colors.text, fontSize: 15, fontWeight: 600 },
  friendUsername: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 },
  challengeIcon: { fontSize: 20, color: theme.colors.primary, marginLeft: 8 },
  requestRow: { display: 'flex', alignItems: 'center', background: theme.colors.card, borderRadius: 12, padding: 16, marginBottom: 8, border: `1px solid ${theme.colors.border}` },
  acceptButton: { background: theme.colors.success, borderRadius: 8, padding: '6px 12px', border: 'none', cursor: 'pointer', color: '#fff', fontWeight: 700, fontSize: 13, marginLeft: 8 },
  declineButton: { background: 'transparent', borderRadius: 8, padding: '6px 12px', border: 'none', cursor: 'pointer', color: theme.colors.danger, fontWeight: 600, fontSize: 13, marginLeft: 6 },
  pendingBadge: { fontSize: 12, fontWeight: 700, color: theme.colors.textMuted, border: `1px solid ${theme.colors.border}`, borderRadius: 8, padding: '4px 12px' },
  emptyText: { color: theme.colors.textMuted, fontSize: 15, textAlign: 'center', padding: 16 },
  wagerCard: { background: theme.colors.card, borderRadius: 12, padding: 16, marginBottom: 8, border: `1px solid ${theme.colors.border}` },
  wagerHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: 6 },
  wagerFriend: { color: theme.colors.text, fontSize: 15, fontWeight: 600 },
  wagerAmount: { color: theme.colors.accent, fontSize: 15, fontWeight: 700 },
  wagerPlayers: { color: theme.colors.textSecondary, fontSize: 13, marginBottom: 8 },
  badge: { display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 4 },
  actionRow: { display: 'flex', gap: 8, alignItems: 'center' },
  playNowButton: { background: theme.colors.success, borderRadius: 8, padding: '8px 16px', border: 'none', cursor: 'pointer', color: '#fff', fontWeight: 800, fontSize: 13 },
  addFriendButton: { background: theme.colors.primary, borderRadius: 8, padding: '8px 12px', border: 'none', cursor: 'pointer', color: theme.colors.background, fontWeight: 700, fontSize: 12 },
  refreshBtn: { background: theme.colors.surface, border: `1px solid ${theme.colors.border}`, borderRadius: 8, padding: '8px 24px', color: theme.colors.textSecondary, cursor: 'pointer', fontSize: 13 },
};
