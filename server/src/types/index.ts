export interface User {
  id: string;
  email: string;
  password_hash: string;
  chess_com_username: string | null;
  display_name: string | null;
  stripe_customer_id: string | null;
  stripe_connect_account_id: string | null;
  stripe_onboarding_complete: boolean;
  venmo_username: string | null;
  created_at: string;
}

export interface Friendship {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'blocked';
  created_at: string;
}

export type WagerStatus =
  | 'pending_acceptance'
  | 'pending_payment'
  | 'both_paid'
  | 'active'
  | 'settled'
  | 'cancelled'
  | 'expired';

export type GameResult = 'challenger_win' | 'opponent_win' | 'draw';

export interface Wager {
  id: string;
  challenger_id: string;
  opponent_id: string;
  amount_cents: number;
  status: WagerStatus;
  challenger_paid: boolean;
  opponent_paid: boolean;
  challenger_payment_intent_id: string | null;
  opponent_payment_intent_id: string | null;
  result: GameResult | null;
  winner_id: string | null;
  game_url: string | null;
  settled_at: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface Transaction {
  id: string;
  wager_id: string;
  user_id: string;
  type: 'bet_payment' | 'payout' | 'refund' | 'draw_refund';
  amount_cents: number;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
  status: 'pending' | 'completed' | 'failed';
  created_at: string;
}

export interface JwtPayload {
  userId: string;
  email: string;
}
