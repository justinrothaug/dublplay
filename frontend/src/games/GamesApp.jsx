import { useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import SetUsernameScreen from './SetUsernameScreen.jsx';
import DublPlayScreen from './DublPlayScreen.jsx';
import NewWagerScreen from './NewWagerScreen.jsx';
import PaymentScreen from './PaymentScreen.jsx';
import PlayScreen from './PlayScreen.jsx';
import { theme } from './theme.js';

export default function GamesApp({ onBackToHub, wallet, profile, onLogout }) {
  const { user, needsRegistration } = useAuth();
  const [screen, setScreen] = useState('main');
  const [screenParams, setScreenParams] = useState(null);
  const [activeTab, setActiveTab] = useState('dublplay');
  const [showProfile, setShowProfile] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);

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

  if (screen === 'newWager') {
    return <NewWagerScreen params={screenParams} onBack={goBack} />;
  }
  if (screen === 'payment') {
    return <PaymentScreen params={screenParams} onBack={goBack} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: theme.colors.background }}>
      {/* Top bar with profile + wallet + back */}
      <div style={styles.topBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button style={styles.backButton} onClick={onBackToHub}>← Hub</button>
          <span
            onClick={() => setShowProfile(true)}
            style={{ fontSize: 13, color: '#8b8fa8', cursor: 'pointer' }}
          >
            {profile?.username || user?.display_name || 'Profile'}
          </span>
          {wallet && (
            <button
              onClick={() => setShowDeposit(true)}
              style={{
                background: 'rgba(212,168,67,0.12)', border: '1px solid #d4a843', borderRadius: 8,
                padding: '4px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 800, color: '#d4a843' }}>
                ${wallet.loading ? '—' : wallet.balanceDollars}
              </span>
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
            {onLogout && <button
              onClick={onLogout}
              style={{
                width: '100%', padding: '10px 0',
                background: 'transparent', color: theme.colors.textSecondary, border: `1px solid ${theme.colors.border}`,
                borderRadius: 8, fontSize: 12, fontWeight: 700,
                letterSpacing: '0.06em', cursor: 'pointer',
              }}
            >Logout</button>}
          </div>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1 }}>
        {activeTab === 'dublplay' ? (
          <DublPlayScreen onNavigate={navigate} />
        ) : (
          <PlayScreen />
        )}
      </div>

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
