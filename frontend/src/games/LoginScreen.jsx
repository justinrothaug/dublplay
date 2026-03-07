import { useState } from 'react';
import { useAuth } from './AuthContext.jsx';

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
      <img src="/loading.png" alt="dublplay" style={styles.bgImage} />
      <div style={styles.overlay}>
        <div style={styles.spacer} />
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
  container: {
    position: 'relative',
    minHeight: '100vh',
    background: '#0a0e1a',
    overflow: 'hidden',
  },
  bgImage: {
    position: 'absolute',
    top: 0,
    left: '50%',
    transform: 'translateX(-50%)',
    width: '100%',
    maxWidth: 480,
    height: '100%',
    objectFit: 'cover',
    objectPosition: 'top center',
  },
  overlay: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minHeight: '100vh',
    padding: '0 24px 48px',
  },
  spacer: { flex: 1 },
  googleButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    background: '#fff',
    border: 'none',
    borderRadius: 12,
    padding: '16px 32px',
    cursor: 'pointer',
    width: '100%',
    maxWidth: 340,
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
  },
  buttonDisabled: { opacity: 0.6, cursor: 'default' },
  googleIcon: { fontSize: 20, fontWeight: 700, color: '#4285F4' },
  googleText: { fontSize: 18, fontWeight: 600, color: '#333' },
};
