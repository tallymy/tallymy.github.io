// Exports from other money apps, recognised by their header row: the columns, which rows are transfers between the
// app's own accounts (and the other account, when the row names it), which rows are balance corrections (folded into
// opening balances, never spending), and their default category names in Tally's terms. Pure: no DOM.
// Hooks get c = {get(key): the mapped column's cell, raw(header): a cell by the app's own column name}; account and
// category hooks, when present, say which cell holds a row's account or category.
// ponytail: English headers only; an app set to another language exports other column names and falls back to the column sheet.

const low = s => String(s ?? '').replace(/[\u0000-\u001f\ufeff"]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');

export const PRESETS = [
  // Tally's own "Export to Excel (CSV)" (io.js toCSV): Date, Type, Amount, Account, To account, Category, Merchant,
  // Item, Note, Time. Transfers name both accounts; an itemised entry is one row per item (each its own entry here).
  { id: 'tally', name: 'Tally', need: ['date', 'type', 'amount', 'account', 'to account', 'category', 'merchant', 'item'],
    cols: { date: ['date'], time: ['time'], type: ['type'], amount: ['amount'], account: ['account'], category: ['category'], merchant: ['merchant'], note: ['note'], sub: ['subcategory'] },
    type: c => ({ income: 'income', expense: 'expense' })[low(c.get('type'))] || null,
    transfer: c => low(c.get('type')) === 'transfer' && { dir: 'out', to: c.raw('to account') } },

  // QIF (GnuCash, HomeBank, Quicken, Moneydance, Money Manager Ex; Tally's own QIF export), turned into rows by
  // io.js qifToRows. Signed amounts, US month-first dates, a transfer's other account in brackets: "[Maybank]".
  { id: 'qif', signed: true, mdy: true, name: 'QIF / OFX', need: ['date', 'amount', 'payee', 'category', 'memo', 'qif account'],
    cols: { date: ['date'], amount: ['amount'], merchant: ['payee'], category: ['category'], note: ['memo'], account: ['qif account'] },
    transfer: c => { const m = String(c.get('category') ?? '').trim().match(/^\[(.+)\]$/); return m && { to: m[1] }; } },

  // Money Manager by Realbyte (com.realbyteapps.moneymanagerfree), "Export to Excel". Columns per the Ivy Wallet
  // importer (github.com/Ivy-Apps/ivy-wallet, CSVMapper.moneyManager: date 0, account 1, category 2, note 4, type 6,
  // description 7, amount 8, currency 9) and vaultix-by-xanny's parser (github.com/ramadiaz/vaultix-by-xanny,
  // money-manager-parser.service.ts): Period, Accounts, Category, Subcategory, Note, <main currency>, Income/Expense,
  // Description, Amount, Currency, Accounts; dates "MM/DD/YYYY HH:MM:SS"; types Income / Expense (Exp.) /
  // Transfer-Out / Transfer-In, both halves of a transfer listed, the other account in Category (Realbyte help centre,
  // "How to import bulk data by Excel file", which also gives the older Date, Account… layout accepted here).
  // "Modified Bal." is its balance-correction category.
  { id: 'realbyte', name: 'Money Manager (Realbyte)', need: [['period', 'date'], ['accounts', 'account'], 'category', 'subcategory', 'income/expense'],
    cols: { date: ['period', 'date'], account: ['accounts', 'account'], category: ['category'], sub: ['subcategory'], merchant: ['note'], note: ['description'], amount: ['amount', 'myr'], type: ['income/expense'] },
    mdy: true,
    transfer: c => { const m = low(c.get('type')).match(/^transfer-?\s*(out|in)/); return m && { dir: m[1], to: c.get('category') }; },
    adjust: c => /^modified bal/.test(low(c.get('category'))),
    cats: { 'social life': 'fun', culture: 'fun', 'self-development': 'education', apparel: 'shopping', beauty: 'personal', gift: 'other', allowance: 'allowance', bonus: 'income', 'petty cash': 'income' } },

  // Money Lover: "ID, Note, Amount, Category, Account, Currency, Date, Event, Exclude Report" (current export, as
  // mirrored by github.com/phucx314/iomoney src/data/csv.ts: dd/MM/yyyy, signed amounts) and the older
  // "Id/No, Date, Category, Amount, Currency, Note, Wallet". Transfers are the categories "Outgoing Transfer" and
  // "Incoming Transfer" (Money Lover's default category list, e.g. github.com/ITBoiz-FPT-K16/money_care categories.js);
  // the other wallet is not named, so the two halves are paired by amount and day.
  { id: 'moneylover', signed: true, mdy: false, name: 'Money Lover', need: ['category', 'amount', 'currency', 'note', ['wallet', 'account'], ['id', 'no', 'exclude report', 'event']],
    cols: { date: ['date'], amount: ['amount'], category: ['category'], merchant: ['note'], account: ['wallet', 'account'] },
    transfer: c => /^(outgoing|incoming) transfer$/.test(low(c.get('category'))),
    // "Adjust Balance" rows (and anything marked Exclude Report) are corrections, not spending; so is "Initial balance".
    adjust: c => /^(adjust balance|initial balance)$/.test(low(c.get('category'))) || /^(true|yes|1)$/.test(low(c.raw('exclude report'))),
    cats: { loan: 'other', repayment: 'loans', debt: 'income', 'debt collection': 'income', 'friends & lover': 'fun', travel: 'fun', 'gifts & donations': 'other', family: 'household', 'home services': 'household', 'home maintainance': 'household', 'home maintenance': 'household', pets: 'household', houseware: 'household', makeup: 'personal', 'personal items': 'personal', 'vehicle maintenance': 'transport', insurances: 'insurance', 'fees & charges': 'bills', rentals: 'housing', 'streaming service': 'fun', award: 'income', gifts: 'income', selling: 'income', 'interest money': 'income', 'collect interest': 'income', 'other income': 'income' } },

  // Spendee: "Date, Wallet, Type, Category name, Amount, Currency, Note, Labels, Author" (github.com/jjpedreno/
  // janus-csv-converter README; github.com/wendyliga/firefly-iii-spendee-import compose.py). ISO dates with a time
  // zone, signed amounts, Type Expense / Income / Outgoing Transfer / Incoming Transfer; one file per wallet, so the
  // halves of a transfer are paired across the files' rows by amount and time.
  { id: 'spendee', name: 'Spendee', need: ['wallet', 'type', 'category name', 'amount', 'currency'],
    cols: { date: ['date'], account: ['wallet'], type: ['type'], category: ['category name'], amount: ['amount'], merchant: ['note'] },
    transfer: c => { const m = low(c.get('type')).match(/^(outgoing|incoming) transfer$/); return m && { dir: m[1] === 'outgoing' ? 'out' : 'in' }; } },

  // Wallet by BudgetBakers, "Export all data" CSV: semicolons; account;category;currency;amount;ref_currency_amount;
  // type;payment_type;payment_type_local;note;date;…;transfer;payee;labels;… with signed amounts, type Income /
  // Expenses, dates "YYYY-MM-DD HH:MM:SS" and both halves of a transfer marked transfer=true, category TRANSFER
  // (github.com/Prajwalsrinvas/wallet_to_cashew_converter README sample; Ivy Wallet CSVMapper.walletByBudgetBakers).
  { id: 'wallet', name: 'Wallet by BudgetBakers', need: ['account', 'category', 'amount', 'ref_currency_amount', 'type', 'transfer'],
    cols: { date: ['date'], account: ['account'], category: ['category'], amount: ['amount'], type: ['type'], merchant: ['payee'], note: ['note'] },
    transfer: c => low(c.raw('transfer')) === 'true' || low(c.get('category')) === 'transfer',
    cats: { 'wage, invoices': 'salary', 'restaurant, fast-food': 'dining', 'life & entertainment': 'fun', 'communication, pc': 'bills', housing: 'household', vehicle: 'transport', 'financial expenses': 'bills', 'refunds (tax, purchase)': 'income', 'sale': 'income', 'lending, renting': 'income' } },

  // Monefy: "date, account, category, amount, currency, converted amount, currency, description", dd/MM/yyyy, signed
  // amounts, a transfer as two rows with the category "To 'Savings'" / "From 'Cash'" (github.com/btittelbach/
  // pyhledger convert-monefy-records.py; Ivy Wallet CSVMapper.monefy).
  { id: 'monefy', signed: true, name: 'Monefy', need: ['date', 'account', 'category', 'amount', 'converted amount', 'description'],
    cols: { date: ['date'], account: ['account'], category: ['category'], amount: ['amount'], merchant: ['description'] },
    transfer: c => { const m = String(c.get('category')).trim().match(/^(To|From) '(.+)'$/i); return m && { dir: /^to$/i.test(m[1]) ? 'out' : 'in', to: m[2] }; },
    cats: { food: 'groceries', 'eating out': 'dining', house: 'household', pets: 'household', taxi: 'transport', car: 'transport', toiletry: 'personal', clothes: 'shopping', communications: 'bills', sports: 'fun', gifts: 'other', deposits: 'income', savings: 'income' } },

  // YNAB register CSV (from "Export budget"): Account, Flag, Date, Payee, Category Group/Category, Category Group,
  // Category, Memo, Outflow, Inflow, Cleared. A transfer is listed in both accounts with the payee "Transfer : <other
  // account>"; "Starting Balance" rows open each account; income sits in "Ready to Assign" (YNAB's own register
  // export; the same header is in this repo's file harness and in Actual Budget's YNAB importers).
  { id: 'ynab', name: 'YNAB', need: ['account', 'date', 'payee', 'outflow', 'inflow'],
    cols: { date: ['date'], account: ['account'], merchant: ['payee'], category: ['category', 'category group/category'], note: ['memo'], debit: ['outflow'], credit: ['inflow'] },
    transfer: c => { const m = String(c.get('merchant')).trim().match(/^transfer\s*:\s*(.+)$/i); return m && { to: m[1] }; },
    adjust: c => ['starting balance', 'reconciliation balance adjustment'].includes(low(c.get('merchant'))),
    cats: { 'ready to assign': 'income', 'inflow: ready to assign': 'income', 'to be budgeted': 'income', 'inflow: to be budgeted': 'income' } },

  // Cashew: account, amount, currency, title, note, date, income, type, category name, subcategory name, color, icon,
  // emoji, budget, objective (github.com/jameskokoska/Cashew budget/lib/widgets/exportCSV.dart). Signed amounts, Dart
  // dates "YYYY-MM-DD HH:MM:SS.mmm". A transfer is two "Balance Correction" rows whose note starts "Transferred
  // Balance" (addWalletPage.dart); other Balance Correction rows are corrections.
  { id: 'cashew', name: 'Cashew', need: ['account', 'amount', 'title', 'date', 'income', 'category name'],
    cols: { date: ['date'], account: ['account'], amount: ['amount'], category: ['category name'], sub: ['subcategory name'], merchant: ['title'], note: ['note'] },
    type: c => (low(c.raw('income')) === 'true' ? 'income' : low(c.raw('income')) === 'false' ? 'expense' : null),
    transfer: c => low(c.get('category')) === 'balance correction' && /^transferred balance/.test(low(c.get('note'))),
    adjust: c => low(c.get('category')) === 'balance correction',
    cats: { transit: 'transport', beauty: 'personal', travel: 'fun', 'bills & fees': 'bills', gifts: 'other', work: 'income' } },

  // Bluecoins: "Type, Date, Set Time, Name (older: Title), Amount, Currency, Exchange Rate, Category Group, Category,
  // Account, Notes, Labels, Status", UTF-8 with a BOM, expenses negative, dates "YYYY-MM-DD HH:MM:SS.mmm"
  // (github.com/usmankaraamat/Hisaab src/import/bluecoins.js; Ivy Wallet CSVMapper.blueCoins). Transfers: Type
  // Transfer, category "(Transfer)" (Bluecoins' import template, github.com/satheeshds/bluecoins-utilities).
  { id: 'bluecoins', name: 'Bluecoins', need: ['type', 'date', 'amount', 'exchange rate', 'category group', 'category', 'account'],
    cols: { date: ['date'], type: ['type'], merchant: ['name', 'title'], amount: ['amount'], category: ['category'], account: ['account'], note: ['notes'] },
    transfer: c => low(c.get('type')) === 'transfer' || low(c.get('category')) === '(transfer)',
    adjust: c => low(c.get('type')) === 'new account' || low(c.get('category')) === '(new account)' },   // an account's opening balance

  // 1Money: "DATE, TYPE, FROM ACCOUNT, TO ACCOUNT / TO CATEGORY, AMOUNT, CURRENCY, AMOUNT 2, CURRENCY 2, TAGS, NOTES",
  // dates MM/dd/yy, unsigned amounts, TYPE Expense / Income / Transfer, one row per transfer (github.com/bladeours/
  // budget-project src/test/resources/import/onemoney.csv and OneMoneyService.java; Ivy Wallet CSVMapper.oneMoney).
  // An Income row also has the account in FROM ACCOUNT and the category in TO: "Income, Santander, Gifts" in
  // bladeours' file (OneMoneyService.getToAccountOrCategory reads the account from FROM ACCOUNT for INCOME), and
  // "Income, Qapital, CardFlight" in github.com/son1112/nostra-ruby spec/fixture/1Money-sample.html.
  { id: 'onemoney', name: '1Money', need: ['date', 'type', 'from account', 'to account / to category', 'amount'],
    cols: { date: ['date'], type: ['type'], account: ['from account'], category: ['to account / to category'], amount: ['amount'], note: ['notes'] },
    mdy: true,
    transfer: c => low(c.get('type')) === 'transfer' && { dir: 'out', to: c.get('category') } },
  // 1Money's newer export: "Date (UTC), Type, From account / from category, From subcategory, To account / to category,
  // To subcategory, Amount 1, Currency 1, Amount 2, Currency 2, Commission, …, Comment", UTC times. Money goes from →
  // to, so an Income row names its category in From and the account in To ("Income, Company Payroll, Primary Account":
  // github.com/fxprima/finance-tracker example-dummy-data/mony-format-dummy.csv, CSVFormatValidator.java).
  { id: 'onemoney', name: '1Money', utc: true, need: ['date (utc)', 'type', 'from account / from category', 'to account / to category', 'amount 1'],
    cols: { date: ['date (utc)'], type: ['type'], account: ['from account / from category'], category: ['to account / to category'], amount: ['amount 1'], note: ['comment'] },
    account: c => (low(c.get('type')) === 'income' ? c.get('category') : c.get('account')),
    category: c => (low(c.get('type')) === 'income' ? c.get('account') : c.get('category')),
    transfer: c => low(c.get('type')) === 'transfer' && { dir: 'out', to: c.get('category') } },

  // Toshl: "Date, Account, Category, Tags, Expense amount, Income amount, Currency, In main currency, Main currency,
  // Description" (github.com/westbury/jmoney ToshlImportWizard.java; github.com/valankar/finance i_and_e.py, which
  // drops the "Transfer" and "Reconciliation" categories).
  { id: 'toshl', name: 'Toshl', need: ['date', 'account', 'category', 'expense amount', 'income amount'],
    cols: { date: ['date'], account: ['account'], category: ['category'], debit: ['expense amount'], credit: ['income amount'], merchant: ['description'] },
    transfer: c => low(c.get('category')) === 'transfer',
    adjust: c => low(c.get('category')) === 'reconciliation',
    amount: c => (low(c.raw('currency')) && low(c.raw('main currency')) && low(c.raw('currency')) !== low(c.raw('main currency')) ? c.raw('in main currency') : null),   // SGD 42.80 → MYR 148.52
    cats: { 'home & utilities': 'bills', leisure: 'fun', 'health & personal care': 'health' } },

  // AndroMoney "Windows Excel" CSV: a banner line, then Id, Currency, Amount, Category, Sub-Category, Date,
  // Expense(Transfer Out), Income(Transfer In), Note, Periodic, Project, Payee/Payer, uid, Time. Dates yyyyMMdd, times
  // HHmm; which account column is filled says expense, income or (both) transfer; Category SYSTEM rows are opening
  // balances; Big5 text (github.com/andresze020/rumbo docs/features/andromoney-import.md).
  { id: 'andromoney', name: 'AndroMoney', need: ['amount', 'category', 'date', 'expense(transfer out)', 'income(transfer in)'],
    cols: { date: ['date'], amount: ['amount'], category: ['category'], sub: ['sub-category'], account: ['expense(transfer out)'], merchant: ['payee/payer'], note: ['note'], time: ['time'] },
    account: c => String(c.get('account')).trim() || c.raw('income(transfer in)'),
    type: c => (String(c.get('account')).trim() ? 'expense' : 'income'),
    transfer: c => !!String(c.get('account')).trim() && !!String(c.raw('income(transfer in)')).trim() && { dir: 'out', to: c.raw('income(transfer in)') },
    adjust: c => low(c.get('category')) === 'system' },

  // Mobills (Brazil): Data, Descrição, Valor, Conta, Categoria, Subcategoria, signed amounts with decimal commas
  // (github.com/mariaffp/projeto-gefin services/importacao.py). ponytail: one source, transfers unknown: they come in as money in and out.
  { id: 'mobills', signed: true, name: 'Mobills', need: ['data', 'descrição', 'valor', 'conta', 'categoria'],
    cols: { date: ['data'], merchant: ['descrição'], amount: ['valor'], account: ['conta'], category: ['categoria'] } },
];

/** A header row (and the file name) → {…preset, map} for the app that wrote it, or null. */
export function detectPreset(header, name = '') {
  const h = header.map(low), has = k => (Array.isArray(k) ? k.some(has) : h.includes(k));
  const hits = PRESETS.filter(x => x.need.every(has)), file = low(name).replace(/[^a-z0-9]/g, '');
  const p = hits.find(x => file.includes(x.id)) || hits[0];   // the file name breaks a tie ("MoneyLover_2026.csv")
  if (!p) return null;
  const map = {};
  for (const [k, names] of Object.entries(p.cols)) { const i = names.map(n => h.indexOf(n)).find(i => i >= 0); if (i != null) map[k] = i; }
  return { ...p, map };
}
