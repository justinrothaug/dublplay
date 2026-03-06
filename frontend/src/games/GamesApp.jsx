import { useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import SetUsernameScreen from './SetUsernameScreen.jsx';
import DublPlayScreen from './DublPlayScreen.jsx';
import NewWagerScreen from './NewWagerScreen.jsx';
import PaymentScreen from './PaymentScreen.jsx';
import PlayScreen from './PlayScreen.jsx';
import { theme } from './theme.js';

export default function GamesApp({ onBackToHub }) {
  const { user, needsRegistration } = useAuth();
  const [screen, setScreen] = useState('main');
  const [screenParams, setScreenParams] = useState(null);
  const [activeTab, setActiveTab] = useState('dublplay');

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
      {/* Back to hub button */}
      <div style={styles.topBar}>
        <button style={styles.backButton} onClick={onBackToHub}>← Back</button>
      </div>

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
          <span style={styles.tabLabel}>DublPlay</span>
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
