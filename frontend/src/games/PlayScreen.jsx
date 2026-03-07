import { useState } from 'react';
import { theme } from './theme.js';

const isNative = () => typeof window !== 'undefined' && window.Capacitor !== undefined;

const PLAY_LINKS = [
  {
    id: 'chesscom',
    name: 'Chess.com',
    url: 'https://www.chess.com',
    icon: '♟',
    subtitle: 'Chess',
    color: '#769656',
  },
  {
    id: 'bga',
    name: 'Board Game Arena',
    url: 'https://boardgamearena.com',
    icon: '🎲',
    subtitle: 'Checkers, Backgammon, Othello, Connect 4 & more',
    color: '#c93f2b',
  },
];

export default function PlayScreen() {
  const [loading, setLoading] = useState(null);

  const openUrl = async (link) => {
    if (isNative()) {
      try {
        setLoading(link.id);
        const { Browser } = window.Capacitor.Plugins;
        await Browser.open({
          url: link.url,
          presentationStyle: 'fullscreen',
        });
      } catch {
        window.open(link.url, '_blank');
      } finally {
        setLoading(null);
      }
    } else {
      window.open(link.url, '_blank');
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.title}>Play Your Game</div>
        <div style={styles.subtitle}>
          Play on any platform below — we'll automatically detect the result and settle your wager.
        </div>
      </div>
      <div style={styles.links}>
        {PLAY_LINKS.map((link) => (
          <button
            key={link.id}
            style={{
              ...styles.linkCard,
              borderColor: link.color,
              opacity: loading === link.id ? 0.6 : 1,
            }}
            onClick={() => openUrl(link)}
            disabled={loading === link.id}
          >
            <span style={styles.linkIcon}>{link.icon}</span>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <div style={styles.linkName}>{link.name}</div>
              <div style={styles.linkSub}>{link.subtitle}</div>
            </div>
            <span style={{ color: link.color, fontSize: 20 }}>&#8599;</span>
          </button>
        ))}
      </div>
      {isNative() && (
        <div style={styles.hint}>
          Opens inside the app — tap "Done" when finished to return
        </div>
      )}
    </div>
  );
}

const styles = {
  container: { flex: 1, background: theme.colors.background, minHeight: '100%', padding: 24 },
  header: { textAlign: 'center', marginBottom: 32, paddingTop: 24 },
  title: { fontSize: 24, fontWeight: 800, color: theme.colors.primary, marginBottom: 8 },
  subtitle: { fontSize: 15, color: theme.colors.textSecondary, lineHeight: 1.5, maxWidth: 400, margin: '0 auto' },
  links: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 400, margin: '0 auto' },
  linkCard: {
    display: 'flex', alignItems: 'center', gap: 14, padding: 18,
    background: theme.colors.card, borderRadius: 14,
    border: '2px solid', cursor: 'pointer', width: '100%', textAlign: 'left',
  },
  linkIcon: { fontSize: 36 },
  linkName: { color: theme.colors.text, fontSize: 17, fontWeight: 700 },
  linkSub: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 },
  hint: { marginTop: 24, fontSize: 13, color: theme.colors.textMuted, textAlign: 'center' },
};
