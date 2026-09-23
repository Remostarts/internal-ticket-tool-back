
import { connectDatabase, disconnect } from '../db/connect.js';
import { env } from '../config/env.js';
import { User } from '../models/user.js';
import { Project } from '../models/project.js';
import { Task } from '../models/task.js';

const prdData = [
  {
    phase: "Core Banking / Fintech Must Haves",
    tasks: [
      { title: "Send Money", description: "Users send money from their Vyybe account to another bank account by selecting the recipient bank, entering the account number and amount, and authorizing the transaction." },
      { title: "Vyybe-to-Vyybe Transfer", description: "Users transfer money to another Vyyb user, usually using the recipient's @Vyybe-Username, phone number or Vyybe account details." },
      { title: "Save beneficiaries", description: "" },
      { title: "Recurring payments/transfers", description: "" },
      { title: "Receive Money", description: "Users receive money into their Vyybe account from another person or from a bank transfer." },
      { title: "Fund Account", description: "Users add money to their Vyybe balance through supported funding methods so they can subsequently make payments or transfers." },
      { title: "Add Money via Bank Card", description: "Users fund their Vyybe account using an eligible debit or bank card linked to the app." },
      { title: "Bank Deposit / Transfer Funding", description: "Users can fund their Vyybe account by transferring money from another bank into their Vyybe account." },
      { title: "Airtime", description: "Users purchase airtime directly from their Vyybe balance for their own phone number or another person's number." },
      { title: "Data", description: "Users purchase mobile data bundles for themselves or another phone number using the Vyybe app." },
      { title: "Electricity Bills", description: "Users pay electricity bills by selecting their electricity distribution company, entering the required meter/customer information and paying from their Vyybe balance." },
      { title: "Cable TV / TV Subscription", description: "Users renew services such as TV subscriptions by selecting their provider and package and paying through Vyybe." },
      { title: "Internet Subscription", description: "Users can pay for supported internet-service subscriptions directly from their Vyybe account." },
      { title: "Betting / Gaming Payments", description: "Users can fund supported betting or gaming accounts from their Vyybe balance where the service is available and permitted." },
      { title: "Other Bill Payments", description: "Users can access additional supported billers and services from the bills-payment section. This will be populated as the Vyybe app grows and gains acceptability." },
      { title: "Debit Card", description: "Users can request and manage an Vyybe debit card for ATM, POS and online transactions." },
      { title: "Card Application", description: "Eligible users can apply for a Vyybe debit card through the app rather than having to begin the process entirely offline." },
      { title: "Card Management", description: "Users can manage aspects of their debit card, including security and usage controls." },
      { title: "ATM Withdrawal", description: "Users withdraw cash from supported ATMs using their Vyybe debit card." },
      { title: "POS Payment", description: "Users pay merchants physically using their Vyybe debit card at POS terminals." },
      { title: "Online Card Payment", description: "Users use their Vyybe debit card for eligible online purchases and services." },
      { title: "Savings / Interest-Earning Balance", description: "Vyybe users can keep money in an interest-generating product rather than leaving all available funds as ordinary transactional balance." },
      { title: "Transaction History", description: "Vyybe users view previous transfers, payments, withdrawals, deposits and other account activities." },
      { title: "Transaction Details", description: "Users open an individual transaction to see information such as date, time, amount, status, recipient and transaction reference." },
      { title: "Transaction Receipt", description: "Users can access transaction confirmation/details after completing a payment or transfer." },
      { title: "Beneficiaries / Saved Recipients", description: "Users can save frequently used recipients so future transfers can be completed faster." },
      { title: "Contacts / Phone-Based Transfer", description: "Users can identify or select recipients using @vyybe-username, phone numbers where supported instead of manually entering full banking details." },
      { title: "Promo / Cashback", description: "Users receive promotional rewards or cashback for qualifying transactions, campaigns or services. Vyybe will offer cashback on some bill payments and incentives on transfers/airtime/data, milestones, referrals etc." },
      { title: "Referral", description: "Existing users can invite new customers through referral mechanisms and potentially receive promotional rewards when qualifying conditions are met." },
      { title: "Rewards / Bonuses", description: "Users can receive promotional benefits associated with selected transactions, campaigns or customer-acquisition activities." },
      { title: "Profile / Account Management", description: "Users manage their personal information, account settings and other customer-account details still keeping primary keys primary." },
      { title: "KYC / Account Verification", description: "Users provide required identity and personal information to verify their account and unlock services appropriate to their account level." },
      { title: "Account Limits", description: "Users can view or operate within transaction/account limits determined by their verification status and applicable regulations." },
      { title: "PIN Management", description: "Users create or change security PINs used to authorize sensitive financial transactions." },
      { title: "Biometric Authentication", description: "Where supported by the device, users can use biometric authentication such as fingerprint or Face ID instead of relying solely on passwords/PINs." },
      { title: "Login Security", description: "The app protects access to the customer's financial account through authentication and security controls." },
      { title: "Account/Card Lock", description: "Vyybe users can quickly lock their account or card when their phone or card is lost or stolen." },
      { title: "Fraud Protection System", description: "Vyybe will use security and fraud-monitoring mechanisms to help protect customer accounts and transactions." },
      { title: "Customer Service", description: "Users will be able to contact Vyybe support through the in-app customer-service centre and other available support channels." },
      { title: "Dispute / Transaction Complaint", description: "Users can report transaction problems and seek assistance when a payment, transfer or other service does not work as expected." },
      { title: "Notifications", description: "Users receive alerts relating to transactions, account activity, promotions and other important account events." },
      { title: "Balance Display", description: "Users can see their available account balance before deciding what transaction or payment to make." },
      { title: "Transaction Status", description: "Users can identify whether a transaction is successful, pending or failed and take appropriate action." },
      { title: "Search / Navigation", description: "Users can locate available services and transactions within the app rather than manually navigating through every product category." },
      { title: "Service Shortcuts", description: "Frequently used services such as transfer, airtime, data and bills can be presented as quick-access functions from the main interface." },
      { title: "Bank Account Details", description: "Users can access the banking/account information required for receiving money or funding their Vyybe account." },
      { title: "Payment Confirmation", description: "Users receive confirmation after successful payments or transfers so they can establish that the transaction was processed." },
      { title: "Failed Transaction Handling", description: "The system identifies unsuccessful transactions and provides status information or a route for resolution." },
      { title: "Pending Transaction Handling", description: "Users can see transactions that have not yet reached final status instead of assuming that every transaction is immediately successful." },
      { title: "Financial Activity Overview", description: "Users can monitor their overall account activity through balances and transaction history." },
      { title: "Customer Support Centre", description: "Users have a central area within the app for accessing help, support information and complaint resolution." }
    ]
  },
  {
    phase: "NOTIFICATIONS",
    tasks: [
      { title: "Transaction Notification", description: "Notify the customer immediately after the transaction." },
      { title: "Debit Alert", description: "Alert customers whenever money leaves the account." },
      { title: "Credit Alert", description: "Alert customer when money enters account." },
      { title: "Failed Transaction Alert", description: "Explain unsuccessful transactions." },
      { title: "Reversal Alert", description: "Notify customers when money is returned." },
      { title: "Security Alert", description: "Notify customers of security events." },
      { title: "Card Alert", description: "Notify card transactions." },
      { title: "Savings Alert", description: "Notify savings deposits/interest/maturity." },
      { title: "Loan Alert", description: "Notify loan disbursement/due dates." },
      { title: "Promotional Notifications", description: "Send relevant offers." },
      { title: "Notification Centre", description: "Store important notifications in one place." },
      { title: "Notification Preferences", description: "Customers control which notifications they receive." }
    ]
  },
  {
    phase: "PERSONAL FINANCE MANAGEMENT",
    tasks: [
      { title: "Spending Dashboard", description: "Show where the user's money goes." },
      { title: "Spending Categories", description: "Automatically classify spending." },
      { title: "Monthly Spending Report", description: "Show monthly income/outflow." },
      { title: "Budgeting", description: "Users set spending budgets." },
      { title: "Budget Alerts", description: "Warn users when approaching budget." },
      { title: "Income Tracking", description: "Identify recurring salary/business income." },
      { title: "Subscription Detection", description: "Identify recurring subscriptions." },
      { title: "Bill Calendar", description: "Show upcoming bills." },
      { title: "Financial Health Score", description: "Score customer's financial behaviour." },
      { title: "Emergency Fund Tracker", description: "Track progress toward emergency savings." },
      { title: "Net Worth Dashboard", description: "Show assets minus liabilities." },
      { title: "Financial Goals", description: "Combine savings, spending and investments around goals." },
      { title: "AI Financial Coach", description: "AI analyses behaviour and gives personalized financial recommendations." }
    ]
  },
  {
    phase: "AI-POWERED VYYBE BANK",
    tasks: [
      { title: "AI Financial Assistant", description: "Users ask natural-language questions about their money." },
      { title: "AI Spending Analysis", description: "AI explains where the user's money is going." },
      { title: "AI Savings Coach", description: "AI recommends how much the user should save." },
      { title: "AI Budget Coach", description: "AI creates a budget based on actual income/spending." },
      { title: "Fraud AI", description: "Detects unusual behaviour before transaction execution." },
      { title: "Smart Transfer Warning", description: "This recipient is new and this amount is unusual for you." },
      { title: "Cashflow Forecast", description: "Predict future balance based on historical behaviour." },
      { title: "Bill Prediction", description: "Predict upcoming bills and required funds." },
      { title: "Smart Savings", description: "Automatically move surplus funds according to agreed rules." },
      { title: "Credit Coach", description: "Explain how customers can improve creditworthiness." },
      { title: "Personalized Offers", description: "Offer relevant products rather than generic adverts." },
      { title: "AI Customer Support", description: "Resolve simple support cases conversationally." },
      { title: "AI Complaint Summary", description: "AI summarizes transaction history for support agents." },
      { title: "AI Can I Afford IT?", description: "AI gives purchase predictions based on inflow and expenses records." }
    ]
  },
  {
    phase: "SOCIAL / GEN-Z FEATURES",
    tasks: [
      { title: "Money Username", description: "Easy-to-remember payment identity." },
      { title: "Social Payments", description: "Send money to friends through a social-style interface." },
      { title: "Split Bills", description: "Split restaurant/travel/group expenses." },
      { title: "Group Wallet", description: "Multiple people contribute to one goal." },
      { title: "Group Savings", description: "Friends save toward a shared goal." },
      { title: "Payment Request", description: "Request money from friends/family." },
      { title: "Gift Money", description: "Send money as a digital gift." },
      { title: "Birthday Money", description: "Send birthday money instantly." },
      { title: "Money Challenges", description: "Savings challenges and financial missions." },
      { title: "Savings Streak", description: "Reward consistent saving." },
      { title: "Financial Leaderboard", description: "Optional/private leaderboard around savings challenges." },
      { title: "Merchant Discovery", description: "Discover offers around you." },
      { title: "Youth Financial Investment", description: "Short, practical financial investment guides." }
    ]
  },
  {
    phase: "CUSTOMER PROFILE & PERSONALIZATION",
    tasks: [
      { title: "Profile", description: "The customer manages personal information." },
      { title: "Profile Photo", description: "Customer personalizes profile." },
      { title: "Preferred Name", description: "The app uses a preferred name." },
      { title: "Communication Preferences", description: "The user controls email/SMS/push communications." },
      { title: "Financial Preferences", description: "The user chooses savings/spending preferences." },
      { title: "Personalized Dashboard", description: "Dashboard changes according to behaviour." },
      { title: "Personalized Offers", description: "Relevant offers based on user behaviour." },
      { title: "Preferred Services", description: "Frequently used services surfaced automatically." }
    ]
  },
  {
    phase: "BUSINESS / FREELANCER EXTENSION",
    tasks: [
      { title: "Business Account", description: "Separate business account." },
      { title: "Payment Link", description: "Business creates payment link." },
      { title: "Merchant QR", description: "Business accepts QR payments." },
      { title: "Invoice", description: "Business creates invoices." },
      { title: "Expense Management", description: "Business tracks spending." },
      { title: "Staff Accounts", description: "Business creates employee payment access." },
      { title: "Payroll", description: "Business pays employees." },
      { title: "Business Analytics", description: "Business sees revenue/expenses." },
      { title: "POS Integration", description: "Integrate physical payment acceptance." },
      { title: "Settlement", description: "Merchant receives payment settlement." }
    ]
  },
  {
    phase: "ADMIN / BACK-OFFICE REQUIREMENTS",
    tasks: [
      { title: "Customer 360", description: "Staff can see the complete customer profile/activity." },
      { title: "Transaction Search", description: "Search every transaction." },
      { title: "Transaction Reconciliation", description: "Reconcile internal records with banks/PSPs." },
      { title: "Automated Reconciliation", description: "The system automatically identifies mismatches." },
      { title: "Settlement Management", description: "Monitor incoming/outgoing settlement." },
      { title: "Dispute Management", description: "Manage customer complaints." },
      { title: "Refund Management", description: "Initiate/approve eligible refunds." },
      { title: "Fraud Dashboard", description: "Monitor suspicious transactions." },
      { title: "Risk Rules Engine", description: "Configure transaction-risk rules." },
      { title: "KYC Dashboard", description: "Monitor verification status." },
      { title: "Account Restriction", description: "Temporarily restrict risky accounts." },
      { title: "Account Unrestriction", description: "Controlled process to restore accounts." },
      { title: "Support CRM", description: "Manage customer conversations." },
      { title: "SLA Monitoring", description: "Monitor complaint-resolution deadlines." },
      { title: "Audit Trail", description: "Every staff action is recorded." },
      { title: "Maker/Checker", description: "Sensitive operations require multiple approvals." },
      { title: "Role-Based Access", description: "Staff only access what their role permits." },
      { title: "Revenue Dashboard", description: "Monitor transaction revenue." },
      { title: "Product Analytics", description: "Monitor product usage." },
      { title: "Customer Analytics", description: "Monitor acquisition/retention." },
      { title: "Real-Time Monitoring", description: "Real-time transaction/service health." }
    ]
  },
  {
    phase: "UNIQUE VALUE PROPOSITION",
    tasks: [
      { title: "Vyybe Wish", description: "Digital celebration wallet that allows users to receive gifts through a dedicated virtual account without exposing primary banking details." },
      { title: "Vyybe Promise", description: "Transforms informal financial commitments into automated, trackable payment agreements (e.g. escrow-style holds)." },
      { title: "Vyybe Wall", description: "Introducing a social aspect to monies spent. Spend money, brag about it on the wall." },
      { title: "Vyybe Grow business", description: "Dedicated digital business account integrating payment collection, POS compatibility, invoicing tools, and real-time cash-flow dashboards." },
      { title: "Vyybe Flow", description: "Automated supplier settlement engine for businesses and distributors." },
      { title: "EXTREMELY CUSTOMIZABLE CARDS", description: "Allow users to design their own debit cards. Choose colour, artwork, theme, etc." },
      { title: "FREEZE EVERYTHING BUTTON", description: "A user can get a friend's phone immediately after a theft is done, login and freeze everything related to their account." },
      { title: "WHERE DID MY MONEY GO", description: "Visual breakdown of expenses: Food 22%, Transport 17%, etc." },
      { title: "Better Transaction Pending Experience", description: "Instead of 'Transaction Pending', app should say: 'We're waiting for confirmation... Expected resolution: 2 mins'." },
      { title: "GET PAID", description: "Generate PAYMENT LINK-->INVOICE-->QR CODE/ACCOUNT DETAILS for them to receive money directly." },
      { title: "VYYBE INVEST", description: "Guide Gen Z into investments. 'If you put ₦10,000 here for 12 months, here's approximately what happens.'" },
      { title: "VYYBE PAYS YOU BACK", description: "Personal and relatable rewards. E.g: Because you spend a lot on food, here's a free ₦5,000 food voucher." },
      { title: "BUILD YOUR SQUAD", description: "Invite 5 friends and unlock: Free transfer week, cashback, etc." }
    ]
  }
];

async function runSeed() {
  await connectDatabase(env.MONGODB_URI);
  console.log('Connected to DB');

  try {
    // Find creator
    const creator = await User.findOne({ email: 'gabriel@vybebank.com' });
    if (!creator) {
      throw new Error('Creator gabriel@vybebank.com not found');
    }
    
    // Find project
    const project = await Project.findOne({ 
      name: { $regex: /vybe bank/i }
    });

    if (!project) {
      throw new Error('Project Vybe Bank not found');
    }

    console.log(`Using Project: ${project.name} (${project._id}) and Creator: ${creator.email}`);

    // Loop through phases
    let position = 1;
    for (const phase of prdData) {
      // Create Phase parent task
      const parentTask = await Task.create({
        project: project._id,
        title: phase.phase,
        description: `Grouped tasks for the ${phase.phase} phase.`,
        priority: 'P2',
        column: 'backlog',
        position: position * 1000,
        creator: creator._id,
        assignee: null,
      });

      console.log(`Created Phase Task: ${parentTask.title}`);

      // Create children tasks
      let childPos = 1;
      for (const feature of phase.tasks) {
        await Task.create({
          project: project._id,
          title: feature.title,
          description: feature.description,
          priority: 'P3',
          column: 'backlog',
          position: (position * 1000) + childPos,
          creator: creator._id,
          assignee: null,
          parent: parentTask._id,
        });
        childPos++;
      }
      
      position++;
    }

    console.log('Successfully seeded VYYBE PRD data into tasks!');
  } catch (error) {
    console.error('Error seeding data:', error);
  } finally {
    await disconnect();
  }
}

runSeed();
