'use strict';

var util = require('util');

var envvar = require('envvar');
var express = require('express');
var bodyParser = require('body-parser');
var moment = require('moment');
var plaid = require('plaid');
const axios = require('axios').default
const admin = require('firebase-admin')
const functions = require('firebase-functions')
const appEnv = functions.config()
admin.initializeApp(appEnv.firebase)
const db = admin.firestore()

var APP_PORT = envvar.number('APP_PORT', 8888);

var PLAID_CLIENT_ID = envvar.string('PLAID_CLIENT_ID', '5f00cfd04ba6640012dc8390');
var PLAID_PUBLIC_KEY = envvar.string('PLAID_PUBLIC_KEY', '3b0e9a2fcea1fb587de3cd7b2fd10a');
var PLAID_SECRET = envvar.string('PLAID_SECRET', 'eb3163f4023d2e75c1797084cff9bc');
var PLAID_ENV = envvar.string('PLAID_ENV', 'development');

// var PLAID_SECRET = envvar.string('PLAID_SECRET', '2af958490020d4c232fa3deb48730b');
// var PLAID_ENV = envvar.string('PLAID_ENV', 'sandbox');

// PLAID_PRODUCTS is a comma-separated list of products to use when initializing
// Link. Note that this list must contain 'assets' in order for the app to be
// able to create and retrieve asset reports.
var PLAID_PRODUCTS = envvar.string('PLAID_PRODUCTS', 'investments');

// PLAID_PRODUCTS is a comma-separated list of countries for which users
// will be able to select institutions from.
var PLAID_COUNTRY_CODES = envvar.string('PLAID_COUNTRY_CODES', 'US');

// Parameters used for the OAuth redirect Link flow.
//
// Set PLAID_OAUTH_REDIRECT_URI to 'http://localhost:8000/oauth-response.html'
// The OAuth redirect flow requires an endpoint on the developer's website
// that the bank website should redirect to. You will need to configure
// this redirect URI for your client ID through the Plaid developer dashboard
// at https://dashboard.plaid.com/team/api.
var PLAID_OAUTH_REDIRECT_URI = envvar.string('PLAID_OAUTH_REDIRECT_URI', '');
// Set PLAID_OAUTH_NONCE to a unique identifier such as a UUID for each Link
// session. The nonce will be used to re-open Link upon completion of the OAuth
// redirect. The nonce must be at least 16 characters long.
var PLAID_OAUTH_NONCE = envvar.string('PLAID_OAUTH_NONCE', '');

// We store the access_token in memory - in production, store it in a secure
// persistent data store
var ACCESS_TOKEN = null;
var PUBLIC_TOKEN = null;
var ITEM_ID = null;
// The payment_token is only relevant for the UK Payment Initiation product.
// We store the payment_token in memory - in production, store it in a secure
// persistent data store
var PAYMENT_TOKEN = null;
var PAYMENT_ID = null;

// Initialize the Plaid client
// Find your API keys in the Dashboard (https://dashboard.plaid.com/account/keys)
var client = new plaid.Client(
  PLAID_CLIENT_ID,
  PLAID_SECRET,
  PLAID_PUBLIC_KEY,
  plaid.environments[PLAID_ENV],
  { version: '2019-05-29', clientApp: 'Plaid Quickstart' }
);

var app = express();
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({
  extended: false
}));
app.use(bodyParser.json());

app.get('/', function (request, response, next) {
  response.render('index.ejs', {
    PLAID_PUBLIC_KEY: PLAID_PUBLIC_KEY,
    PLAID_ENV: PLAID_ENV,
    PLAID_PRODUCTS: PLAID_PRODUCTS,
    PLAID_COUNTRY_CODES: PLAID_COUNTRY_CODES,
    PLAID_OAUTH_REDIRECT_URI: PLAID_OAUTH_REDIRECT_URI,
    PLAID_OAUTH_NONCE: PLAID_OAUTH_NONCE,
    ITEM_ID: ITEM_ID,
    ACCESS_TOKEN: ACCESS_TOKEN,
  });
});

// This is an endpoint defined for the OAuth flow to redirect to.
app.get('/oauth-response.html', function (request, response, next) {
  response.render('oauth-response.ejs', {
    PLAID_PUBLIC_KEY: PLAID_PUBLIC_KEY,
    PLAID_ENV: PLAID_ENV,
    PLAID_PRODUCTS: PLAID_PRODUCTS,
    PLAID_COUNTRY_CODES: PLAID_COUNTRY_CODES,
    PLAID_OAUTH_NONCE: PLAID_OAUTH_NONCE,
  });
});

// Exchange token flow - exchange a Link public_token for
// an API access_token
// https://plaid.com/docs/#exchange-token-flow
app.post('/get_access_token', function (request, response, next) {
  const { userName, userId } = request.body
  PUBLIC_TOKEN = request.body.public_token;
  client.exchangePublicToken(PUBLIC_TOKEN, function (error, tokenResponse) {
    if (error != null) {
      prettyPrintResponse(error);
      return response.json({
        error: error,
      });
    }
    ACCESS_TOKEN = tokenResponse.access_token;
    ITEM_ID = tokenResponse.item_id;

    db.collection('users').doc(userId).set({
      userId,
      userName,
      items: [{
        itemId: tokenResponse.item_id,
        accessToken: tokenResponse.access_token
      }]
    })

    response.json({
      access_token: ACCESS_TOKEN,
      item_id: ITEM_ID,
      error: null,
    });
  });
});

app.post('/login', function (request, response, next) {
  const { user_id: userId, user_name: userName } = request.body
  response.json({
    "text": "Test formatting",
    "blocks": [
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `Visit this URL to login:\n*<https://${request.hostname}/api?userId=${userId}&userName=${userName}|Link your account!>*`
        }
      }
    ]
  })
});

app.post('/update-folio', async function (request, response, next) {
  const { response_url, actions: [{ value }] } = JSON.parse(request.body.payload)

  const message = await getHoldings(value)
  axios.post(response_url,
    {
      "text": "Folio",
      "blocks": message.blocks
    })

  return response.json({
    "status": "Success"
  });
});

app.post('/plaid-webhook', async function (request, response, next) {
  functions.logger.log(request.body)
  response.json({
    "status": "success"
  })

  const { webhook_type, item_id } = request.body
  if (!['HOLDINGS', 'INVESTMENTS_TRANSACTIONS'].includes(webhook_type)) return
  
  const allUsers = await db.collection('users').get()
  
  let foundUser
  allUsers.forEach(function (doc) {
    if (doc.data().items[0].itemId === item_id) foundUser = doc.data()
  })
  if (!foundUser) return
  functions.logger.log(foundUser.userName)

  switch (webhook_type) {
    case 'HOLDINGS':
      getHoldings(foundUser.userId, foundUser.items[0].accessToken)
      break;
    case 'INVESTMENTS_TRANSACTIONS':
      postInvestmentTransactions(foundUser)
      break;
    default:
      break;
  }
});

// Retrieve Holdings for an Item
// https://plaid.com/docs/#investments
app.post('/holdings', async function (request, response, next) {
  const { user_id: userId } = request.body
  const message = await getHoldings(userId)
  axios.post('https://hooks.slack.com/services/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',
    {
      "text": "Folio",
      "blocks": message.blocks
    })
  return response.json({
    "text": "Success!"
  });
})
// Retrieve Investment Transactions for an Item
// https://plaid.com/docs/#investments
app.get('/investment_transactions', function (request, response, next) {
  var startDate = moment().subtract(30, 'days').format('YYYY-MM-DD');
  var endDate = moment().format('YYYY-MM-DD');
  client.getInvestmentTransactions(ACCESS_TOKEN, startDate, endDate, function (error, investmentTransactionsResponse) {
    if (error != null) {
      prettyPrintResponse(error);
      return response.json({
        error: error,
      });
    }
    prettyPrintResponse(investmentTransactionsResponse);
    response.json({ error: null, investment_transactions: investmentTransactionsResponse });
  });
});

const postInvestmentTransactions = async (userData) => {
  const investmentTransactions = await getInvestmentTransactions(userData.items[0].accessToken, 1)
  // const newSet = new Set(investmentTransactions.investment_transactions)
  // const oldSet = new Set(userData.investment_transactions)
  // const diff = difference(newSet, oldSet)
  // if (diff.size < 1) return

  if (investmentTransactions.investment_transactions.length < 1) return

  storeTransactionData(userData.userId, investmentTransactions)

  let actionMessage = {
    "blocks": [
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*Here's the latest transactions for ${userData.userName}*`
        }
      },
      {
        "type": "section",
        "fields": []
      }
    ]
  }

  investmentTransactions.investment_transactions.map(item => {
    actionMessage.blocks[1].fields.push({
      "type": "mrkdwn",
      "text": `${item.name}\n`
    },
      {
        "type": "mrkdwn",
        "text": `${item.quantity} @ $${item.price}`
      })
  })

  // Array.from(diff).map(item => {
  //   actionMessage.blocks[1].fields.push({
  //     "type": "mrkdwn",
  //     "text": `${item.name}\n`
  //   },
  //     {
  //       "type": "mrkdwn",
  //       "text": `${item.quantity} @ $${item.price}`
  //     })
  // })

  axios.post('https://hooks.slack.com/services/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',
    {
      "text": "Transactions",
      "blocks": actionMessage.blocks
    })

  function difference(setA, setB) {
    let _difference = new Set(setA)
    for (let elem of setB) {
      _difference.delete(elem)
    }
    return _difference
  }

}

const fetchAndStoreTransactions = async (userId, accessToken) => {
  const investmentTransactionsResponse = await getInvestmentTransactions(accessToken, 30)
  storeTransactionData(userId, investmentTransactionsResponse)
}

const getInvestmentTransactions = (accessToken, delta = 7) => {
  var startDate = moment().subtract(delta, 'days').format('YYYY-MM-DD');
  var endDate = moment().format('YYYY-MM-DD');
  return client.getInvestmentTransactions(accessToken, startDate, endDate)
}

// var server = app.listen(APP_PORT, function () {
//   console.log('plaid-quickstart server listening on port ' + APP_PORT);
// });

var prettyPrintResponse = response => {
  console.log(util.inspect(response, { colors: true, depth: 4 }));
};

const getHoldings = async (userId, accessToken) => {
  let userDoc
  if (!accessToken) {
    userDoc = await db.collection('users').doc(userId).get()
    accessToken = userDoc.data().items[0].accessToken
  }
  const holdingsResponse = await client.getHoldings(accessToken)
  storeHoldingData(userId, holdingsResponse)
  if (!userDoc.data().investmentTransactions) fetchAndStoreTransactions(userId, accessToken)
  return contructSlackMessage(userId, userDoc.data().userName, holdingsResponse)
}

const storeHoldingData = (userId, holdingsResponse) => {
  db.collection('users').doc(userId).update({
    investments: holdingsResponse
  })
}

const storeTransactionData = (userId, investmentTransactionsResponse) => {
  db.collection('users').doc(userId).update({
    investmentTransactions: investmentTransactionsResponse
  })
}

const contructSlackMessage = (userId, userName, holdingsResponse) => {
  const { holdings, securities } = holdingsResponse
  const finalHoldings = holdings.map((item) => {
    const secItem = securities.filter(x => x.security_id === item.security_id)[0]
    return { ...item, ...secItem }
  })
  let actionMessage = {
    "blocks": [
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*Here's your portfolio, ${userName}*`
        }
      },
      {
        "type": "section",
        "fields": [
          {
            "type": "mrkdwn",
            "text": "*Name:*\n"
          },
          {
            "type": "mrkdwn",
            "text": "*Value:*\n"
          }
        ]
      },
      {
        "type": "actions",
        "elements": [
          {
            "type": "button",
            "text": {
              "type": "plain_text",
              "emoji": true,
              "text": "Refresh"
            },
            "style": "primary",
            "value": userId
          }
        ]
      }
    ]
  }
  let newFields = []
  let totalValue = 0
  let unitChange = 0
  let netChange = 0
  finalHoldings.forEach(function (item) {
    totalValue = totalValue + item.institution_value
    unitChange = (item.institution_value - item.cost_basis).toFixed(2)
    netChange = netChange + parseFloat(unitChange)
    newFields.push({
      "type": "section",
      "fields": [{
        "type": "mrkdwn",
        "text": `${item.name || item.ticker_symbol}\n_Qty: ${item.quantity}_`
      },
      {
        "type": "mrkdwn",
        "text": `$${new Intl.NumberFormat().format(item.institution_value)}\n_Chg: ${unitChange}_`
      }]
    })
  })
  newFields.push({
    "type": "section",
    "fields": [{
      "type": "mrkdwn",
      "text": `*Total*`
    },
    {
      "type": "mrkdwn",
      "text": `*$${new Intl.NumberFormat().format(totalValue)}*\nChg: ${new Intl.NumberFormat().format(netChange)}`
    }]
  }, {
    "type": "context",
    "elements": [
      {
        "type": "plain_text",
        "text": `Last updated: ${moment().format('YYYY-MM-DD')}`,
        "emoji": true
      }
    ]
  })
  actionMessage.blocks.splice(2, 0, ...newFields)
  return actionMessage
}

const decodeTicker = (tickerSymbol) => {
  const parts = new RegExp(/((\d{2})(\d{2})(\d{2}))([PC])(\d{8})/g).exec(tickerSymbol)
  if (!parts || parts.length === 0) return tickerSymbol
  return `${tickerSymbol.split(parts[0])[0]} ${moment(`20${parts[2]}-${parts[3]}-${parts[4]}`).format('ll')} ${parts[5].toUpperCase() === 'P' ? 'PUT' : 'CALL'} @ $${parts[6]/1000}`
}

app.post('/set_access_token', function (request, response, next) {
  ACCESS_TOKEN = request.body.access_token;
  client.getItem(ACCESS_TOKEN, function (error, itemResponse) {
    response.json({
      item_id: itemResponse.item.item_id,
      error: false,
    });
  });
});

// Create a one-time use link_token for the Item.
// This link_token can be used to initialize Link
// in update mode for the user
app.post('/create_link_token', function(request, response, next) {
  // 1. Grab the client_user_id by searching for the current user in your database
  // const user = await User.find(...);
  // const clientUserId = user.id;
  const clientUserId = '';

  // 2. Create a link_token for the given user
  plaidClient.createLinkToken({
    user: {
      client_user_id: clientUserId,
    },
    client_name: 'My App',
    country_codes: ['US'],
    language: 'en',
    access_token: ACCESS_TOKEN,
  }, (err, res) => {
    const link_token = res.link_token;

    // 3. Send the data to the client
    response.json({ link_token: link_token });
  });
});

module.exports = app
