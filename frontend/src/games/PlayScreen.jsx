import { useState } from 'react';
import { theme } from './theme.js';

const isNative = () => typeof window !== 'undefined' && window.Capacitor !== undefined;

export default function PlayScreen() {
  const [loading, setLoading] = useState(false);

  const openChess = async () => {
    if (isNative()) {
      try {
        setLoading(true);
        const { Browser } = window.Capacitor.Plugins;
        await Browser.open({
          url: 'https://www.chess.com',
          presentationStyle: 'fullscreen',
        });
      } catch {
        window.open('https://www.chess.com', '_blank');
      } finally {
        setLoading(false);
      }
    } else {
      window.open('https://www.chess.com', '_blank');
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.webContent}>
        <div style={styles.chessIcon}>♞</div>
        <div style={styles.title}>Play on Chess.com</div>
        <div style={styles.subtitle}>
          Play your game on Chess.com — we'll automatically detect the result and settle your wager.
        </div>
        <button
          style={{ ...styles.playButton, ...(loading ? { opacity: 0.6 } : {}) }}
          onClick={openChess}
          disabled={loading}
        >
          {isNative() ? 'Play Chess.com' : 'Open Chess.com'}
        </button>
        {isNative() && (
          <div style={styles.hint}>
            Opens inside the app — tap "Done" when finished to return
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: { flex: 1, background: theme.colors.background, minHeight: '100%' },
  webContent: { display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: 32, minHeight: 400 },
  chessIcon: { fontSize: 64, marginBottom: 16 },
  title: { fontSize: 24, fontWeight: 800, color: theme.colors.primary, marginBottom: 12 },
  subtitle: { fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center', marginBottom: 32, lineHeight: 1.5, maxWidth: 400 },
  playButton: { background: theme.colors.primary, padding: '16px 32px', borderRadius: 8, border: 'none', cursor: 'pointer', color: theme.colors.background, fontSize: 18, fontWeight: 700 },
  hint: { marginTop: 16, fontSize: 13, color: theme.colors.textMuted, textAlign: 'center' },
};
