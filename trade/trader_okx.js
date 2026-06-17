const OkxAPI = require('./api/okx_api');
const utils = require('../helpers/utils');
const config = require('../modules/configReader');

/**
 * API endpoints:
 * https://www.okx.com/docs-v5/en/
 */
const apiServer = 'https://www.okx.com';
const exchangeName = 'OKX';

module.exports = (
    apiKey,
    secretKey,
    passphrase,
    log,
    publicOnly = false,
    loadMarket = true,
    useSocket = false,
    useSocketPull = false,
    accountNo = 0,
    coin1 = config.coin1,
    coin2 = config.coin2,
) => {
  const okxApiClient = OkxAPI();

  okxApiClient.setConfig(apiServer, apiKey, secretKey, passphrase, log, publicOnly);

  if (loadMarket) {
    getMarkets();
  }

  /**
   * @param {String} [pair] In classic format as BTC/USDT
   * @returns {Promise<Object|undefined>}
   */
  function getMarkets(pair) {
    const paramString = `pair: ${pair}`;

    if (module.exports.gettingMarkets) return;
    if (module.exports.exchangeMarkets) {
      return module.exports.exchangeMarkets[pair ? formatPairName(pair).pairPlain : pair];
    }

    module.exports.gettingMarkets = true;

    return new Promise((resolve) => {
      okxApiClient.instruments('SPOT').then((markets) => {
        try {
          const result = {};

          for (const market of markets) {
            if (market.state !== 'live') {
              continue;
            }

            const pairNames = formatPairName(market.instId);

            const coin1Decimals = countDecimals(market.lotSz);
            const coin2Decimals = countDecimals(market.tickSz);

            result[pairNames.pairPlain] = {
              pairReadable: pairNames.pairReadable,
              pairPlain: pairNames.pairPlain,
              coin1: pairNames.coin1,
              coin2: pairNames.coin2,
              coin1Decimals,
              coin2Decimals,
              coin1Precision: utils.getPrecision(coin1Decimals),
              coin2Precision: utils.getPrecision(coin2Decimals),
              coin1MinAmount: +market.minSz,
              coin1MaxAmount: +market.maxMktSz || null,
              coin2MinPrice: null,
              coin2MaxPrice: null,
              minTrade: +market.minSz,
              status: market.state === 'live' ? 'ONLINE' : 'OFFLINE',
              pairId: market.instId,
            };
          }

          if (Object.keys(result).length > 0) {
            module.exports.exchangeMarkets = result;
            log.log(`Received info about ${Object.keys(result).length} markets on ${exchangeName} exchange.`);
          }

          resolve(result);
        } catch (error) {
          log.warn(`Error while processing getMarkets(${paramString}) request: ${error}`);
          resolve(undefined);
        }
      }).catch((error) => {
        log.warn(`API request getMarkets() of ${utils.getModuleName(module.id)} module failed. ${error}`);
        resolve(undefined);
      }).finally(() => {
        module.exports.gettingMarkets = false;
      });
    });
  }

  return {
    /**
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Object|undefined}
     */
    marketInfo(pair) {
      return getMarkets(pair);
    },

    features() {
      return {
        getMarkets: true,
        getCurrencies: false,
        placeMarketOrder: false,
        allowAmountForMarketBuy: false,
        getDepositAddress: false,
        createDepositAddressWithWebsiteOnly: false,
        getTradingFees: false,
        getAccountTradeVolume: false,
        getFundHistory: false,
        getFundHistoryImplemented: false,
        socketSupport: false,
      };
    },

    getLastAuthMode() {
      return okxApiClient.getLastAuthMode();
    },

    /**
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Object|undefined>}
     */
    async getRates(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let ticker;

      try {
        const data = await okxApiClient.ticker(coinPair.pairPlain);
        ticker = data?.[0];
      } catch (error) {
        log.warn(`API request getRates(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (!ticker) {
          return undefined;
        }

        return {
          ask: +ticker.askPx,
          bid: +ticker.bidPx,
          last: +ticker.last,
          volume: +ticker.vol24h,
          volumeInCoin2: +ticker.volCcy24h,
          high: +ticker.high24h,
          low: +ticker.low24h,
        };
      } catch (error) {
        log.warn(`Error while processing getRates(${paramString}) request result: ${JSON.stringify(ticker)}. ${error}`);
        return undefined;
      }
    },

    /**
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Object|undefined>}
     */
    async getOrderBook(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let book;

      try {
        const data = await okxApiClient.orderBook(coinPair.pairPlain);
        book = data?.[0];
      } catch (error) {
        log.warn(`API request getOrderBook(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = {
          bids: [],
          asks: [],
        };

        (book.asks || []).forEach((level) => {
          result.asks.push({
            amount: +level[1],
            price: +level[0],
            count: +level[3] || 1,
            type: 'ask-sell-right',
          });
        });
        result.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

        (book.bids || []).forEach((level) => {
          result.bids.push({
            amount: +level[1],
            price: +level[0],
            count: +level[3] || 1,
            type: 'bid-buy-left',
          });
        });
        result.bids.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));

        return result;
      } catch (error) {
        log.warn(`Error while processing getOrderBook(${paramString}) request result: ${JSON.stringify(book)}. ${error}`);
        return undefined;
      }
    },

    async getOpenOrders() {
      return [];
    },

    async getBalances() {
      return [];
    },

    async placeOrder() {
      return false;
    },

    async cancelOrder() {
      return false;
    },

    async getTradesHistory(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      try {
        const trades = await okxApiClient.trades(coinPair.pairPlain, 100);
        return trades.map((trade) => ({
          tradeId: trade.tradeId,
          price: +trade.px,
          coin1Amount: +trade.sz,
          time: +trade.ts,
          type: trade.side === 'buy' ? 'buy' : 'sell',
        }));
      } catch (error) {
        log.warn(`API request getTradesHistory(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }
    },

    formatPairName,
  };
};

/**
 * @param {string} sizeStr OKX size string like "0.0001" or "1"
 * @returns {number}
 */
function countDecimals(sizeStr) {
  const str = String(sizeStr);
  if (!str.includes('.')) {
    return 0;
  }
  return str.split('.')[1].length;
}

/**
 * @param {string} pair Pair in classic or OKX format
 * @returns {{ coin1: string, coin2: string, pair: string, pairReadable: string, pairPlain: string }}
 */
function formatPairName(pair) {
  pair = pair.toUpperCase();

  if (pair.indexOf('-') > -1) {
    pair = pair.replace('-', '/');
  } else if (pair.indexOf('_') > -1) {
    pair = pair.replace('_', '/');
  }

  const [coin1, coin2] = pair.split('/');

  return {
    coin1,
    coin2,
    pair: `${coin1}/${coin2}`,
    pairReadable: `${coin1}/${coin2}`,
    pairPlain: `${coin1}-${coin2}`,
  };
}
