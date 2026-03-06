import { useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { theme } from './theme.js';

export default function SetUsernameScreen() {
  const { completeRegistration, firebaseUser, logout } = useAuth();
  const [chessUsername, setChessUsername] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!chessUsername.trim()) {
      alert('Please enter your Chess.com username');
      return;
    }
    setLoading(true);
    try {
      await completeRegistration(chessUsername.trim());
    } catch (err) {
      alert('Error: ' + err.message);
    }
    setLoading(false);
  };

  return (
    <div style={styles.container}>
      <div style={styles.content}>
        <div style={styles.title}>Almost there!</div>
        <div style={styles.subtitle}>
          Welcome {firebaseUser?.displayName || firebaseUser?.email}. Link your Chess.com account to get started.
        </div>
        <label style={styles.label}>Chess.com Username</label>
        <input
          style={styles.input}
          value={chessUsername}
          onChange={(e) => setChessUsername(e.target.value)}
          placeholder="e.g. magnuscarlsen"
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button
          style={{ ...styles.button, ...(loading ? styles.buttonDisabled : {}) }}
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading ? 'Saving...' : 'Continue'}
        </button>
        <div style={styles.link} onClick={logout}>Sign out</div>
      </div>
    </div>
  );
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', minHeight: '100%', background: theme.colors.background },
  content: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 24, maxWidth: 400, margin: '0 auto', width: '100%' },
  title: { fontSize: 28, fontWeight: 800, color: theme.colors.primary, textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 15, color: theme.colors.textSecondary, textAlign: 'center', marginBottom: 32 },
  label: { color: theme.colors.textSecondary, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, display: 'block' },
  input: { width: '100%', background: theme.colors.surface, borderRadius: 8, padding: 16, color: theme.colors.text, fontSize: 15, border: `1px solid ${theme.colors.border}`, outline: 'none', boxSizing: 'border-box' },
  button: { width: '100%', background: theme.colors.primary, borderRadius: 8, padding: 16, textAlign: 'center', marginTop: 24, border: 'none', cursor: 'pointer', color: theme.colors.background, fontSize: 18, fontWeight: 800 },
  buttonDisabled: { opacity: 0.6, cursor: 'default' },
  link: { color: theme.colors.textSecondary, textAlign: 'center', marginTop: 24, fontSize: 15, cursor: 'pointer' },
};
