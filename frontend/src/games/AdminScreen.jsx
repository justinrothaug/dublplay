import { useState, useEffect } from 'react';
import { adminApi } from './api.js';
import { theme } from './theme.js';

const T = theme.colors;

export default function AdminScreen({ onBack }) {
  const [tab, setTab] = useState('users'); // 'users' | 'payouts'
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [payouts, setPendingPayouts] = useState([]);
  const [paidPayouts, setPaidPayouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingUser, setEditingUser] = useState(null);
  const [editBalance, setEditBalance] = useState('');
  const [payoutTab, setPayoutTab] = useState('pending');

  const loadUsers = async (q) => {
    try {
      const data = await adminApi.users(q);
      setUsers(data.users || []);
    } catch (err) { console.error(err); }
  };

  const loadPayouts = async () => {
    try {
      const [pending, paid] = await Promise.all([
        adminApi.payouts('pending'),
        adminApi.payouts('completed'),
      ]);
      setPendingPayouts(pending.payouts || []);
      setPaidPayouts(paid.payouts || []);
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    (async () => {
      await Promise.all([loadUsers(''), loadPayouts()]);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => loadUsers(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const handleSaveBalance = async (userId) => {
    const cents = Math.round(parseFloat(editBalance) * 100);
    if (isNaN(cents) || cents < 0) return;
    try {
      await adminApi.updateBalance(userId, cents);
      setEditingUser(null);
      setEditBalance('');
      loadUsers(search);
    } catch (err) { alert(err.message); }
  };

  const handleMarkPaid = async (payoutId) => {
    try {
      await adminApi.markPaid(payoutId);
      loadPayouts();
    } catch (err) { alert(err.message); }
  };

  const tabStyle = (active) => ({
    flex: 1, padding: '10px 0', border: 'none',
    borderBottom: active ? `2px solid ${T.primary}` : '2px solid transparent',
    background: 'transparent', color: active ? T.primary : T.textSecondary,
    fontWeight: 700, fontSize: 14, cursor: 'pointer',
  });

  return (
    <div style={{ minHeight: '100vh', background: T.background, color: T.text }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', background: T.surface, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: T.primary, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>← Hub</button>
        <span style={{ fontSize: 18, fontWeight: 800, color: T.primary }}>Admin</span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}` }}>
        <button style={tabStyle(tab === 'users')} onClick={() => setTab('users')}>Users</button>
        <button style={tabStyle(tab === 'payouts')} onClick={() => setTab('payouts')}>
          Payouts {payouts.length > 0 && <span style={{ background: T.danger, color: '#fff', borderRadius: 10, padding: '1px 6px', fontSize: 11, marginLeft: 4 }}>{payouts.length}</span>}
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: T.textSecondary }}>Loading...</div>
      ) : tab === 'users' ? (
        <div style={{ padding: 16 }}>
          {/* Search */}
          <input
            placeholder="Search users..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%', padding: '10px 14px', marginBottom: 16,
              background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
              color: T.text, fontSize: 16, fontFamily: 'inherit', outline: 'none',
              boxSizing: 'border-box',
            }}
          />

          {/* User list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {users.map(u => (
              <div key={u.id} style={{
                background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{u.displayName || u.email}</span>
                    {u.admin && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: T.primary, background: 'rgba(212,168,67,0.15)', padding: '1px 6px', borderRadius: 4 }}>ADMIN</span>}
                  </div>
                  {editingUser === u.id ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ color: T.textSecondary, fontSize: 14 }}>$</span>
                      <input
                        autoFocus
                        type="number" step="0.01" min="0"
                        value={editBalance}
                        onChange={e => setEditBalance(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSaveBalance(u.id)}
                        style={{
                          width: 80, padding: '4px 8px', background: T.background, border: `1px solid ${T.border}`,
                          borderRadius: 6, color: T.text, fontSize: 16, fontFamily: 'inherit', outline: 'none',
                        }}
                      />
                      <button onClick={() => handleSaveBalance(u.id)} style={{ padding: '4px 10px', background: T.success, color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Save</button>
                      <button onClick={() => { setEditingUser(null); setEditBalance(''); }} style={{ padding: '4px 8px', background: 'transparent', color: T.textSecondary, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>X</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditingUser(u.id); setEditBalance((u.walletBalanceCents / 100).toFixed(2)); }}
                      style={{
                        background: 'rgba(212,168,67,0.12)', border: `1px solid ${T.primary}`, borderRadius: 6,
                        padding: '4px 12px', color: T.primary, fontWeight: 800, fontSize: 14, cursor: 'pointer',
                      }}
                    >${(u.walletBalanceCents / 100).toFixed(2)}</button>
                  )}
                </div>
                <div style={{ fontSize: 12, color: T.textSecondary, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <span>{u.email}</span>
                  {u.chessComUsername && <span>Chess: {u.chessComUsername}</span>}
                  {u.venmoUsername && <span>Venmo: @{u.venmoUsername}</span>}
                </div>
              </div>
            ))}
            {users.length === 0 && <div style={{ textAlign: 'center', color: T.textSecondary, padding: 20 }}>No users found</div>}
          </div>
        </div>
      ) : (
        <div style={{ padding: 16 }}>
          {/* Payout sub-tabs */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              onClick={() => setPayoutTab('pending')}
              style={{
                padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                background: payoutTab === 'pending' ? T.primary : T.surface,
                color: payoutTab === 'pending' ? T.background : T.textSecondary,
                border: `1px solid ${payoutTab === 'pending' ? T.primary : T.border}`,
              }}
            >Pending ({payouts.length})</button>
            <button
              onClick={() => setPayoutTab('paid')}
              style={{
                padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                background: payoutTab === 'paid' ? T.success : T.surface,
                color: payoutTab === 'paid' ? '#fff' : T.textSecondary,
                border: `1px solid ${payoutTab === 'paid' ? T.success : T.border}`,
              }}
            >Paid ({paidPayouts.length})</button>
          </div>

          {/* Payout list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(payoutTab === 'pending' ? payouts : paidPayouts).map(p => (
              <div key={p.id} style={{
                background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{p.userName}</div>
                  <div style={{ fontSize: 12, color: T.textSecondary }}>
                    Venmo: @{p.venmoUsername} &middot; ${(p.amountCents / 100).toFixed(2)}
                  </div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                    {new Date(p.createdAt).toLocaleDateString()} {new Date(p.createdAt).toLocaleTimeString()}
                  </div>
                </div>
                {payoutTab === 'pending' ? (
                  <button
                    onClick={() => handleMarkPaid(p.id)}
                    style={{
                      padding: '8px 16px', background: T.success, color: '#fff', border: 'none',
                      borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    }}
                  >Mark Paid</button>
                ) : (
                  <span style={{ color: T.success, fontSize: 12, fontWeight: 700 }}>Paid</span>
                )}
              </div>
            ))}
            {(payoutTab === 'pending' ? payouts : paidPayouts).length === 0 && (
              <div style={{ textAlign: 'center', color: T.textSecondary, padding: 20 }}>
                No {payoutTab === 'pending' ? 'pending' : 'paid'} payouts
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
