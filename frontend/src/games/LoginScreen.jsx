import { useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { theme } from './theme.js';

export default function LoginScreen() {
  const { signInWithGoogle } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    setLoading(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      if (err.code !== 'auth/popup-closed-by-user') {
        alert('Sign In Failed: ' + err.message);
      }
    }
    setLoading(false);
  };

  return (
    <div style={styles.container}>
      <div style={styles.content}>
        <div style={styles.title}>DublPlay</div>
        <div style={styles.subtitle}>Sports betting & chess wagers</div>
        <button
          style={{ ...styles.googleButton, ...(loading ? styles.buttonDisabled : {}) }}
          onClick={handleGoogleSignIn}
          disabled={loading}
        >
          <span style={styles.googleIcon}>G</span>
          <span style={styles.googleText}>
            {loading ? 'Signing in...' : 'Sign in with Google'}
          </span>
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', minHeight: '100%', background: theme.colors.background },
  content: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 24, maxWidth: 400, margin: '0 auto', width: '100%' },
  title: { fontSize: 36, fontWeight: 800, color: theme.colors.primary, textAlign: 'center', marginBottom: 4 },
  subtitle: { fontSize: 15, color: theme.colors.textSecondary, textAlign: 'center', marginBottom: 52 },
  googleButton: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, background: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: 16, cursor: 'pointer', width: '100%' },
  buttonDisabled: { opacity: 0.6, cursor: 'default' },
  googleIcon: { fontSize: 20, fontWeight: 700, color: '#4285F4' },
  googleText: { fontSize: 18, fontWeight: 600, color: '#333' },
};
