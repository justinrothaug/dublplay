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
  const [searchResults, setSearchResults] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchTimeout = useState({ current: null })[0];

  const loadData = useCallback(async () => {
    try {
      const [f, r, w] = await Promise.all([
        friendsApi.list(),
        friendsApi.requests(),
        wagersApi.list(),
      ]);
      setFriends(f);
      setRequests(r);
      setWagers(w.filter(x => x.status !== 'cancelled' && x.status !== 'declined' && x.status !== 'settled'));
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

  const handleSearchChange = (value) => {
    setUsername(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!value.trim()) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }
    searchTimeout.current = setTimeout(async () => {
      try {
        const results = await friendsApi.search(value.trim());
        setSearchResults(results);
        setShowDropdown(true);
      } catch (err) {
        console.error('Friend search error:', err);
        setSearchResults([]);
        setShowDropdown(true);
      }
    }, 200);
  };

  const handleSelectUser = async (selectedUser) => {
    setShowDropdown(false);
    setSearchResults([]);
    setUsername('');
    try {
      await friendsApi.sendRequest(selectedUser.display_name);
      alert(`Friend request sent to ${selectedUser.display_name}`);
      loadData();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  const handleSendRequest = async () => {
    if (!username.trim()) return;
    setShowDropdown(false);
    setSearchResults([]);
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
  const handlePlayNow = async (item) => {
    const url = getChallengeUrl(item);
    try { await wagersApi.markPlaying(item.id); } catch {}
    openUrl(url);
    loadData();
  };
  const handleCheckResult = async (id) => {
    try {
      const res = await wagersApi.checkResult(id);
      if (res.settled === false) {
        alert('No completed game found yet. Try again in a moment.');
      } else {
        loadData();
        onWalletRefresh?.();
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };
  const handleClaimWin = async (id) => {
    try {
      await wagersApi.claimWin(id);
      loadData();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };
  const handleConfirmWin = async (id) => {
    try {
      await wagersApi.confirmWin(id);
      loadData();
      onWalletRefresh?.();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };
  const handleDenyWin = async (id) => {
    try {
      await wagersApi.denyWin(id);
      loadData();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };
  const handleChallengeFriend = (friend) => {
    onNavigate('newWager', { friendId: friend.id, friendName: friend.display_name, friendUsername: friend.chess_com_username });
  };
  const handleAddOnBga = async (item) => {
    openUrl(`https://boardgamearena.com/player?name=${item.bga_username}`);
    try { await friendsApi.markBgaAdded(item.friendship_id); loadData(); } catch {}
  };

  const getOpponentPlatformUsername = (w) =>
    w.challengerId === user?.id ? w.opponent_platform_username : w.challenger_platform_username;

  const getChallengeUrl = (wager) => {
    const opponentUsername = getOpponentPlatformUsername(wager);
    const platform = wager.platform || 'chesscom';
    const isChallenger = wager.challengerId === user?.id;
    if (platform === 'chesscom' && opponentUsername) {
      const color = isChallenger ? 'white' : 'black';
      return `https://www.chess.com/play/${opponentUsername}`;
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

  const iHaveClickedPlay = (w) => {
    const isChallenger = w.challengerId === user?.id;
    return isChallenger ? w.challengerPlaying : w.opponentPlaying;
  };

  const isPendingForMe = (w) =>
    w.status === 'pending_acceptance' && w.opponentId === user?.id;
  const isSentByMe = (w) =>
    w.status === 'pending_acceptance' && w.challengerId === user?.id;

  return (
    <div style={styles.container}>
      <div style={styles.list}>
        <div style={styles.sectionTitle}>Friends</div>
        {friends.length === 0 ? (
          <div style={styles.emptyText}>No friends yet. Search for someone below!</div>
        ) : (
          friends.map((item) => (
            <div key={item.friendship_id} style={styles.friendRow}>
              <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => handleChallengeFriend(item)}>
                <div style={styles.friendName}>{item.display_name}</div>
                <div style={styles.friendUsername}>
                  {item.chess_com_username && <span>@{item.chess_com_username}</span>}
                  {item.chess_com_username && item.bga_username && <span> · </span>}
                  {item.bga_username && <span>BGA: {item.bga_username}</span>}
                </div>
              </div>
              {item.bga_username && (
                item.bga_friend_added ? (
                  <span style={styles.bgaAddedBadge}>BGA Added</span>
                ) : (
                  <button
                    style={styles.bgaLinkButton}
                    onClick={(e) => { e.stopPropagation(); handleAddOnBga(item); }}
                  >
                    Add on BGA
                  </button>
                )
              )}
              <span style={styles.challengeIcon} onClick={() => handleChallengeFriend(item)}>⚔</span>
            </div>
          ))
        )}

        <div style={{ position: 'relative', marginBottom: 16 }}>
          <div style={styles.addRow}>
            <input
              style={styles.input}
              value={username}
              onChange={(e) => handleSearchChange(e.target.value)}
              onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
              placeholder="Add friend..."
              onKeyDown={(e) => e.key === 'Enter' && handleSendRequest()}
            />
            <button style={styles.sendButton} onClick={handleSendRequest}>Send</button>
          </div>
          {showDropdown && (
            <div style={styles.dropdown}>
              {searchResults.length === 0 ? (
                <div style={{ padding: '12px 16px', color: theme.colors.textMuted, fontSize: 13 }}>No users found</div>
              ) : (
                searchResults.map((r) => (
                  <div
                    key={r.id}
                    style={styles.dropdownItem}
                    onMouseDown={() => handleSelectUser(r)}
                  >
                    <div style={styles.friendName}>{r.display_name}</div>
                    {r.chess_com_username && (
                      <div style={styles.friendUsername}>@{r.chess_com_username}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
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
                    {item.platform === 'custom' && item.customDescription
                      ? item.customDescription
                      : item.gameType
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
                  ) : item.status === 'active' || item.status === 'both_paid' ? (
                    item.cancelRequestedBy && item.cancelRequestedBy !== user?.id ? (
                      <div style={styles.actionRow}>
                        <span style={{ ...styles.badge, border: `1px solid ${theme.colors.textMuted}`, color: theme.colors.textMuted }}>CANCEL REQUESTED</span>
                        <button style={styles.acceptButton} onClick={() => handleCancelWager(item.id)}>Accept Cancel</button>
                      </div>
                    ) : item.cancelRequestedBy === user?.id ? (
                      <div style={styles.actionRow}>
                        <span style={{ ...styles.badge, border: `1px solid ${theme.colors.textMuted}`, color: theme.colors.textMuted }}>CANCEL PENDING</span>
                      </div>
                    ) : item.platform === 'custom' ? (
                      <div style={styles.actionRow}>
                        {item.winClaimedBy === user?.id ? (
                          <span style={{ ...styles.badge, border: `1px solid ${theme.colors.accent}`, color: theme.colors.accent }}>WAITING FOR CONFIRMATION</span>
                        ) : item.winClaimedBy ? (
                          <>
                            <span style={{ fontSize: 13, color: theme.colors.textSecondary }}>{getOpponentName(item)} claims they won</span>
                            <button style={styles.acceptButton} onClick={() => handleConfirmWin(item.id)}>Accept</button>
                            <button style={styles.declineButton} onClick={() => handleDenyWin(item.id)}>Deny</button>
                          </>
                        ) : (
                          <button style={{ ...styles.badge, background: theme.colors.success, color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 800, padding: '6px 16px' }} onClick={() => handleClaimWin(item.id)}>
                            I WON
                          </button>
                        )}
                        <button style={styles.declineButton} onClick={() => handleCancelWager(item.id)}>Cancel</button>
                      </div>
                    ) : (
                      <div style={styles.actionRow}>
                        {iHaveClickedPlay(item) ? (
                          <button style={{ ...styles.badge, background: theme.colors.success, color: '#fff', border: 'none', cursor: 'pointer' }} onClick={() => handlePlayNow(item)}>
                            GAME IN PROGRESS
                          </button>
                        ) : (
                          <button style={{ ...styles.badge, background: theme.colors.primary, color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 800, padding: '6px 16px' }} onClick={() => handlePlayNow(item)}>
                            PLAY
                          </button>
                        )}
                        <button style={styles.declineButton} onClick={() => handleCancelWager(item.id)}>Cancel</button>
                      </div>
                    )
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
  bgaLinkButton: { background: 'transparent', border: `1px solid ${theme.colors.primary}`, borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: theme.colors.primary, fontWeight: 600, fontSize: 11, marginRight: 4, whiteSpace: 'nowrap' },
  bgaAddedBadge: { background: 'transparent', border: `1px solid ${theme.colors.success}`, borderRadius: 6, padding: '4px 8px', color: theme.colors.success, fontWeight: 600, fontSize: 11, marginRight: 4, whiteSpace: 'nowrap' },
  refreshBtn: { background: theme.colors.surface, border: `1px solid ${theme.colors.border}`, borderRadius: 8, padding: '8px 24px', color: theme.colors.textSecondary, cursor: 'pointer', fontSize: 13 },
  dropdown: { position: 'absolute', top: '100%', left: 0, right: 0, background: theme.colors.surface, border: `1px solid ${theme.colors.border}`, borderRadius: 8, marginTop: 4, zIndex: 10, overflow: 'hidden', maxHeight: 240, overflowY: 'auto' },
  dropdownItem: { padding: '10px 16px', cursor: 'pointer', borderBottom: `1px solid ${theme.colors.border}` },
};
