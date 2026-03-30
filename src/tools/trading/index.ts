export {
  portfolioManager,
  PORTFOLIO_MANAGER_DESCRIPTION,
  alertManager,
  ALERT_MANAGER_DESCRIPTION,
  sendNotification,
  SEND_NOTIFICATION_DESCRIPTION,
  watchlistManager,
  WATCHLIST_MANAGER_DESCRIPTION,
} from './trading-tools.js';

export {
  evaluateAlertRules,
  evaluatePortfolioSignals,
  collectWatchedTickers,
} from './signal-detector.js';

export type { TickerSnapshot } from './signal-detector.js';

export { loadPortfolio, savePortfolio, addPosition, removePosition } from './portfolio-store.js';
export { loadAlertStore, addAlertRule, removeAlertRule } from './alert-store.js';
export type * from './types.js';
