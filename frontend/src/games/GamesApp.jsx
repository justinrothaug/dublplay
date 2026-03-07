import { useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { authApi } from './api.js';
import SetUsernameScreen from './SetUsernameScreen.jsx';
import DublPlayScreen from './DublPlayScreen.jsx';
import NewWagerScreen from './NewWagerScreen.jsx';
import PlayScreen from './PlayScreen.jsx';
import { theme } from './theme.js';

export default function GamesApp({ onBackToHub, wallet, profile, WalletModal }) {
  const { user, needsRegistration, logout, disconnectChess, refreshUser } = useAuth();
  const [screen, setScreen] = useState('main');
  const [screenParams, setScreenParams] = useState(null);
  const [activeTab, setActiveTab] = useState('dublplay');
  const [showProfile, setShowProfile] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [linkingBga, setLinkingBga] = useState(false);
  const [bgaInput, setBgaInput] = useState('');

  // User is logged in via Firebase but hasn't set Chess.com username yet
  if (!user || needsRegistration) {
    return <SetUsernameScreen />;
  }

  const navigate = (dest, params) => {
    setScreen(dest);
    setScreenParams(params);
  };

  const goBack = () => {
    setScreen('main');
    setScreenParams(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: theme.colors.background }}>
      {/* Challenge modal overlay */}
      {screen === 'newWager' && (
        <div style={styles.modalOverlay} onClick={goBack}>
          <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <NewWagerScreen params={screenParams} onBack={goBack} onWalletRefresh={wallet?.refresh} walletBalance={wallet?.balanceDollars} />
          </div>
        </div>
      )}

      {/* Top bar with profile + wallet + back */}
      <div style={styles.topBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button style={styles.backButton} onClick={onBackToHub}>← Hub</button>
          <button
            onClick={() => setShowProfile(true)}
            style={{
              width: 30, height: 30, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0,
              background: profile?.username ? profile.color : '#555',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 800, color: '#fff',
            }}
          >{(profile?.username || user?.display_name || '?')[0].toUpperCase()}</button>
          {wallet && (
            <button
              onClick={() => setShowWallet(true)}
              style={{
                background: 'rgba(212,168,67,0.12)', border: '1px solid #d4a843', borderRadius: 8,
                padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                fontSize: 13, fontWeight: 800, color: '#d4a843',
              }}
            >
              ${wallet.loading ? '—' : wallet.balanceDollars}
              <span style={{ fontSize: 10, color: '#d4a843' }}>+</span>
            </button>
          )}
        </div>
      </div>

      {/* Profile dropdown */}
      {showProfile && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)' }} onClick={() => setShowProfile(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            position: 'absolute', top: 52, left: 12,
            background: theme.colors.card, border: `1px solid ${theme.colors.border}`,
            borderRadius: 14, padding: 20, width: 240,
            boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontSize: 10, color: theme.colors.textSecondary, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 12 }}>PROFILE</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{
                width: 40, height: 40, borderRadius: '50%',
                background: profile?.username ? theme.colors.primary : theme.colors.textMuted,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, fontWeight: 800, color: '#fff',
              }}>
                {profile?.username ? profile.username[0].toUpperCase() : '?'}
              </div>
              <div>
                <div style={{ color: theme.colors.text, fontSize: 14, fontWeight: 700 }}>{profile?.username || 'Not set'}</div>
                <div style={{ color: theme.colors.success, fontSize: 12, fontWeight: 700 }}>${wallet ? wallet.balanceDollars : '0.00'}</div>
              </div>
            </div>
            <div style={{ fontSize: 10, color: theme.colors.textSecondary, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 8, marginTop: 4 }}>LINKED ACCOUNTS</div>
            {user?.chess_com_username && (
              <div style={{
                padding: '8px 12px', marginBottom: 6,
                background: theme.colors.surface, border: `1px solid ${theme.colors.border}`,
                borderRadius: 8, fontSize: 13, color: theme.colors.textSecondary,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div>
                  <span style={{ fontWeight: 600, color: theme.colors.text }}>{user.chess_com_username}</span>
                  <span style={{ marginLeft: 4, opacity: 0.6 }}>Chess.com</span>
                </div>
                <button
                  onClick={() => { setShowProfile(false); disconnectChess(); }}
                  style={{ background: 'none', border: 'none', color: theme.colors.danger, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                >Disconnect</button>
              </div>
            )}
            {user?.bga_username ? (
              <div style={{
                padding: '8px 12px', marginBottom: 6,
                background: theme.colors.surface, border: `1px solid ${theme.colors.border}`,
                borderRadius: 8, fontSize: 13, color: theme.colors.textSecondary,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div>
                  <span style={{ fontWeight: 600, color: theme.colors.text }}>{decodeURIComponent(user.bga_username)}</span>
                  <span style={{ marginLeft: 4, opacity: 0.6 }}>BGA</span>
                </div>
                <button
                  onClick={async () => {
                    try {
                      await authApi.updatePlatformUsernames(null, '');
                      await refreshUser();
                    } catch (err) { alert('Error: ' + err.message); }
                  }}
                  style={{ background: 'none', border: 'none', color: theme.colors.danger, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                >Disconnect</button>
              </div>
            ) : linkingBga ? (
              <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                <input
                  style={{
                    flex: 1, padding: '8px 10px', background: theme.colors.surface,
                    border: `1px solid ${theme.colors.border}`, borderRadius: 8,
                    color: theme.colors.text, fontSize: 13, outline: 'none',
                  }}
                  value={bgaInput}
                  onChange={(e) => setBgaInput(e.target.value)}
                  placeholder="BGA username"
                  autoFocus
                />
                <button
                  onClick={async () => {
                    if (!bgaInput.trim()) return;
                    try {
                      await authApi.updatePlatformUsernames(null, bgaInput.trim());
                      await refreshUser();
                      setLinkingBga(false);
                      setBgaInput('');
                    } catch (err) { alert('Error: ' + err.message); }
                  }}
                  style={{
                    padding: '8px 12px', background: theme.colors.primary, border: 'none',
                    borderRadius: 8, color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer',
                  }}
                >Link</button>
              </div>
            ) : (
              <button
                onClick={() => setLinkingBga(true)}
                style={{
                  width: '100%', padding: '8px 12px', marginBottom: 6,
                  background: theme.colors.surface, border: `1px dashed ${theme.colors.border}`,
                  borderRadius: 8, fontSize: 13, color: theme.colors.primary,
                  cursor: 'pointer', fontWeight: 600,
                }}
              >+ Link Board Game Arena</button>
            )}
          </div>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1 }}>
        {activeTab === 'dublplay' ? (
          <DublPlayScreen onNavigate={navigate} onWalletRefresh={wallet?.refresh} />
        ) : (
          <PlayScreen />
        )}
      </div>

      {/* Wallet modal */}
      {showWallet && WalletModal && <WalletModal onClose={() => setShowWallet(false)} onSuccess={wallet.refresh} wallet={wallet} />}

      {/* Bottom tabs */}
      <div style={styles.bottomNav}>
        <button
          style={activeTab === 'dublplay' ? styles.tabActive : styles.tab}
          onClick={() => setActiveTab('dublplay')}
        >
          <span style={{ fontSize: 22 }}>♟</span>
          <span style={styles.tabLabel}>dublplay</span>
        </button>
        <button
          style={activeTab === 'play' ? styles.tabActive : styles.tab}
          onClick={() => setActiveTab('play')}
        >
          <span style={{ fontSize: 22 }}>♞</span>
          <span style={styles.tabLabel}>Play</span>
        </button>
      </div>
    </div>
  );
}

const styles = {
  modalOverlay: {
    position: 'fixed', inset: 0, zIndex: 9999,
    background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
  },
  modalContent: {
    background: theme.colors.background, borderRadius: 16,
    border: `1px solid ${theme.colors.border}`,
    width: '100%', maxWidth: 440, maxHeight: '85vh', overflowY: 'auto',
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  },
  topBar: { padding: '8px 16px', background: theme.colors.surface, borderBottom: `1px solid ${theme.colors.border}` },
  backButton: { background: 'none', border: 'none', color: theme.colors.primary, fontSize: 15, fontWeight: 600, cursor: 'pointer', padding: '4px 0' },
  bottomNav: {
    display: 'flex',
    background: theme.colors.surface,
    borderTop: `1px solid ${theme.colors.border}`,
    position: 'sticky',
    bottom: 0,
  },
  tab: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0 12px', background: 'none', border: 'none', cursor: 'pointer', opacity: 0.5, color: theme.colors.textMuted },
  tabActive: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0 12px', background: 'none', border: 'none', cursor: 'pointer', opacity: 1, color: theme.colors.primary },
  tabLabel: { fontSize: 11, fontWeight: 600, marginTop: 2 },
};
