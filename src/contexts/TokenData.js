import React, { createContext, useContext, useReducer, useMemo, useCallback, useEffect } from 'react'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

import { useWhitelistedTokens } from './Application'
import { useEthPrice } from './GlobalData'

import { jediSwapClientV2 } from '../apollo/v2/client'

import { TOP_TOKENS_DATA, HISTORICAL_TOKENS_DATA, TOKEN_PAIRS_DATA, TOKENS_DATA } from '../apollo/v2/queries'

import { get2DayPercentChange, getPercentChange, isStarknetAddress } from '../utils'
import { apiTimeframeOptions } from '../constants'

const UPDATE = 'UPDATE'
const UPDATE_TOP_TOKENS = ' UPDATE_TOP_TOKENS'
const UPDATE_ALL_PAIRS = 'UPDATE_ALL_PAIRS'

const TOKEN_PAIRS_KEY = 'TOKEN_PAIRS_KEY'

dayjs.extend(utc)

const TokenDataContext = createContext()

export function useTokenDataContext() {
  return useContext(TokenDataContext)
}

function reducer(state, { type, payload }) {
  switch (type) {
    case UPDATE: {
      const { tokenAddress, data } = payload
      return {
        ...state,
        [tokenAddress]: {
          ...state?.[tokenAddress],
          ...data,
        },
      }
    }
    case UPDATE_TOP_TOKENS: {
      const { topTokens } = payload
      let added = {}
      topTokens &&
        topTokens.map((token) => {
          return (added[token.tokenAddress] = token)
        })
      return {
        ...state,
        ...added,
      }
    }

    case UPDATE_ALL_PAIRS: {
      const { address, allPairs } = payload
      return {
        ...state,
        [address]: {
          ...state?.[address],
          [TOKEN_PAIRS_KEY]: allPairs,
        },
      }
    }
    default: {
      throw Error(`Unexpected action type in DataContext reducer: '${type}'.`)
    }
  }
}

export default function Provider({ children }) {
  const [state, dispatch] = useReducer(reducer, {})
  const update = useCallback((tokenAddress, data) => {
    if (!tokenAddress) {
      return
    }
    dispatch({
      type: UPDATE,
      payload: {
        tokenAddress,
        data,
      },
    })
  }, [])

  const updateTopTokens = useCallback((topTokens) => {
    dispatch({
      type: UPDATE_TOP_TOKENS,
      payload: {
        topTokens,
      },
    })
  }, [])

  const updateAllPairs = useCallback((address, allPairs) => {
    dispatch({
      type: UPDATE_ALL_PAIRS,
      payload: { address, allPairs },
    })
  }, [])

  return (
    <TokenDataContext.Provider
      value={useMemo(
        () => [
          state,
          {
            update,
            updateTopTokens,
            updateAllPairs,
          },
        ],
        [state, update, updateTopTokens, updateAllPairs]
      )}
    >
      {children}
    </TokenDataContext.Provider>
  )
}

const getTopTokens = async (ethPrice, ethPriceOld, whitelistedIds = []) => {
  try {
    // need to get the top tokens by liquidity by need token day datas
    const currentDate = parseInt(Date.now() / 86400 / 1000) * 86400 - 86400

    let tokenids = await jediSwapClientV2.query({
      query: TOP_TOKENS_DATA(whitelistedIds),
      fetchPolicy: 'network-only',
      variables: { date: currentDate - 1000000 },
    })

    const ids = tokenids?.data?.tokensDayData?.reduce((accum, { tokenAddress }) => {
      if (!accum.includes(tokenAddress)) {
        accum.push(tokenAddress)
      }
      return accum
    }, [])

    const bulkResults = getBulkTokenData(ids, ethPrice, ethPriceOld)
    return bulkResults
    // calculate percentage changes and daily changes
  } catch (e) {
    console.log(e)
  }
}

const getBulkTokenData = async (ids, ethPrice, ethPriceOld) => {
  try {
    let current = await jediSwapClientV2.query({
      query: TOKENS_DATA(ids),
      fetchPolicy: 'cache-first',
    })

    let historicalData = await jediSwapClientV2.query({
      query: HISTORICAL_TOKENS_DATA(ids, [apiTimeframeOptions.oneDay, apiTimeframeOptions.twoDays, apiTimeframeOptions.oneWeek]),
      fetchPolicy: 'cache-first',
    })

    let oneDayData = historicalData?.data?.tokensData.reduce((acc, currentValue, i) => {
      return { ...acc, [currentValue.tokenAddress]: currentValue?.period?.[apiTimeframeOptions.oneDay] }
    }, {})

    let twoDaysData = historicalData?.data?.tokensData.reduce((acc, currentValue, i) => {
      return { ...acc, [currentValue.tokenAddress]: currentValue?.period?.[apiTimeframeOptions.twoDays] }
    }, {})

    let bulkResults = await Promise.all(
      current &&
        oneDayData &&
        twoDaysData &&
        current?.data?.tokens.map(async (token) => {
          let data = token

          let oneDayHistory = oneDayData?.[token.tokenAddress]
          let twoDaysHistory = twoDaysData?.[token.tokenAddress]

          // calculate percentage changes and daily changes
          const [oneDayVolumeUSD, volumeChangeUSD] = get2DayPercentChange(
            data.volumeUSD,
            oneDayHistory?.volumeUSD ?? 0,
            twoDaysHistory?.volumeUSD ?? 0
          )
          const [oneDayVolumeETH, volumeChangeETH] = get2DayPercentChange(
            data.volume * data.derivedETH,
            oneDayHistory?.volume && oneDayHistory?.derivedETH ? oneDayHistory?.volume * oneDayHistory?.derivedETH : 0,
            twoDaysHistory?.volume && twoDaysHistory?.derivedETH ? twoDaysHistory?.volume * twoDaysHistory?.derivedETH : 0
          )

          const [oneDayTxns, txnChange] = get2DayPercentChange(data.txCount, oneDayHistory?.txCount ?? 0, twoDaysHistory?.txCount ?? 0)

          const tvlUSD = data?.totalValueLockedUSD ? parseFloat(data.totalValueLockedUSD) : 0
          const tvlUSDChange = getPercentChange(data?.totalValueLockedUSD, oneDayHistory?.totalValueLockedUSD)
          const tvlToken = data?.totalValueLocked ? parseFloat(data.totalValueLocked) : 0
          const priceUSD = data?.derivedETH ? parseFloat(data.derivedETH) * ethPrice : 0
          const priceUSDOneDay = oneDayHistory?.derivedETH ? parseFloat(oneDayHistory.derivedETH) * ethPriceOld : 0
          const priceUSDChange = priceUSD && priceUSDOneDay ? getPercentChange(priceUSD.toString(), priceUSDOneDay.toString()) : 0

          const txCount =
            data?.txCount && oneDayHistory?.txCount
              ? parseFloat(data.txCount) - parseFloat(oneDayHistory.txCount)
              : data
              ? parseFloat(data.txCount)
              : 0
          const feesUSD =
            data?.feesUSD && oneDayHistory?.feesUSD
              ? parseFloat(data.feesUSD) - parseFloat(oneDayHistory.feesUSD)
              : data
              ? parseFloat(data.feesUSD)
              : 0

          // const currentLiquidityUSD = data?.totalLiquidity * ethPrice * data?.derivedETH
          // const oldLiquidityUSD = oneDayHistory?.totalLiquidity * ethPriceOld * oneDayHistory?.derivedETH

          data.priceUSD = priceUSD
          data.priceChangeUSD = priceUSDChange

          data.totalLiquidityUSD = tvlUSD
          data.liquidityChangeUSD = tvlUSDChange
          // data.liquidityToken = tvlToken

          data.oneDayVolumeUSD = parseFloat(oneDayVolumeUSD)
          data.volumeChangeUSD = volumeChangeUSD
          data.oneDayVolumeETH = parseFloat(oneDayVolumeETH)
          data.volumeChangeETH = volumeChangeETH

          data.oneDayTxns = oneDayTxns
          data.txnChange = txnChange

          data.feesUSD = feesUSD

          // used for custom adjustments
          data.oneDayData = oneDayHistory
          data.twoDaysData = twoDaysHistory

          return data
        })
    )
    return bulkResults
  } catch (e) {
    console.log(e)
  }
}

const getTokenPairs = async (tokenAddress) => {
  try {
    // fetch all current and historical data
    let result = await jediSwapClientV2.query({
      query: TOKEN_PAIRS_DATA(tokenAddress),
      fetchPolicy: 'cache-first',
    })
    return result.data?.['pairs0'].concat(result.data?.['pairs1'])
  } catch (e) {
    console.log(e)
  }
}

export function Updater() {
  const [, { updateTopTokens }] = useTokenDataContext()
  const [ethPrice, ethPriceOld] = useEthPrice()
  const whitelistedTokens = useWhitelistedTokens() ?? {}
  useEffect(() => {
    async function getData() {
      // get top pairs for overview list
      let topTokens = await getTopTokens(ethPrice, ethPriceOld, Object.keys(whitelistedTokens))

      topTokens && updateTopTokens(topTokens)
    }
    ethPrice && ethPriceOld && getData()
  }, [ethPrice, ethPriceOld, updateTopTokens])
  return null
}

export function useTokenData(tokenAddress) {
  const [state, { update }] = useTokenDataContext()
  const [ethPrice, ethPriceOld] = useEthPrice()
  const tokenData = state?.[tokenAddress]

  useEffect(() => {
    if (!tokenData && ethPrice && ethPriceOld && isStarknetAddress(tokenAddress)) {
      getBulkTokenData([tokenAddress], ethPrice, ethPriceOld).then((data) => {
        update(tokenAddress, data)
      })
    }
  }, [ethPrice, ethPriceOld, tokenAddress, tokenData, update])

  return tokenData || {}
}

export function useTokenDataForList(addresses) {
  const [state, { update }] = useTokenDataContext()
  const [ethPrice] = useEthPrice()
  const allTokensData = useAllTokenData()

  const untrackedAddresses = addresses.reduce((accum, address) => {
    if (!Object.keys(allTokensData).includes(address) && isStarknetAddress(address)) {
      accum.push(address)
    }
    return accum
  }, [])

  // filter for pools with data
  const tokensWithData = addresses
    .map((address) => {
      const tokenData = allTokensData[address]
      return tokenData ?? undefined
    })
    .filter((v) => !!v)

  useEffect(() => {
    async function fetchData() {
      if (!untrackedAddresses.length) {
        return
      }
      let data = await getBulkTokenData(untrackedAddresses, ethPrice)
      data &&
        data.forEach((p) => {
          update(p.id, p)
        })
    }
    if (untrackedAddresses.length) {
      fetchData()
    }
  }, [untrackedAddresses, ethPrice, update])
  return tokensWithData
}

export function useTokenPairs(tokenAddress) {
  const [state, { updateAllPairs }] = useTokenDataContext()
  const tokenPairs = state?.[tokenAddress]?.[TOKEN_PAIRS_KEY]

  useEffect(() => {
    async function fetchData() {
      let allPairs = await getTokenPairs(tokenAddress)
      updateAllPairs(tokenAddress, allPairs)
    }
    if (!tokenPairs && isStarknetAddress(tokenAddress)) {
      fetchData()
    }
  }, [tokenAddress, tokenPairs, updateAllPairs])

  return tokenPairs || []
}

export function useAllTokenData() {
  const [state] = useTokenDataContext()

  // filter out for only addresses
  return Object.keys(state)
    .filter((key) => key !== 'combinedVol')
    .reduce((res, key) => {
      res[key] = state[key]
      return res
    }, {})
}
