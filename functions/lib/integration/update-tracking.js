const axios = require('axios')
const { firestore } = require('firebase-admin')
const logger = require('firebase-functions/logger')
const { setup } = require('@ecomplus/application-sdk')
const getAppData = require('../store-api/get-app-data')

const listStoreIds = () => {
  const storeIds = []
  const date = new Date()
  date.setHours(date.getHours() - 24)

  return firestore()
    .collection('ecomplus_app_auth')
    .where('updated_at', '>', firestore.Timestamp.fromDate(date))
    .get().then(querySnapshot => {
      querySnapshot.forEach(documentSnapshot => {
        const storeId = documentSnapshot.get('store_id')
        if (storeIds.indexOf(storeId) === -1) {
          storeIds.push(storeId)
        }
      })
      return storeIds
    })
}

const fetchTracking = ({ appSdk, storeId }) => {
  return new Promise((resolve, reject) => {
    getAppData({ appSdk, storeId })
      .then(async (appData) => {
        resolve()
        const contract = appData.flashcourier_contract
        if (contract) {
          const {
            login,
            password,
            hmac,
            client_id: clientId,
            cct_id: cctIds
          } = contract
          if (login && password && hmac && clientId && cctIds) {
            let flashcourierToken
            try {
              const { data } = await axios({
                method: 'post',
                url: 'https://webservice.flashpegasus.com.br/FlashPegasus/rest/api/v1/token',
                headers: {
                  Authorization: hmac
                },
                data: {
                  login,
                  senha: password
                }
              })
              flashcourierToken = data.access_token
            } catch (err) {
              logger.error(err)
            }
            if (!flashcourierToken) return
            logger.info(`[track] #${storeId} ${flashcourierToken}`)
            let orders
            const ordersEndpoint = '/orders.json?fields=_id,number,fulfillment_status' +
              '&shipping_lines.flags=flashcr-ws' +
              '&fulfillment_status.current!=delivered' +
              `&created_at>=${new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString()}`
            try {
              const { response } = await appSdk.apiRequest(storeId, ordersEndpoint, 'GET')
              orders = response.data.result
            } catch (err) {
              logger.error(err)
            }
            if (!orders.length) return
            logger.info(`[track] #${storeId} ${orders.map(({ _id }) => _id).join(' ')}`)
            try {
              const { data: { hawbs } } = await axios({
                method: 'post',
                url: 'https://webservice.flashpegasus.com.br/FlashPegasus/rest/padrao/v2/consulta',
                headers: {
                  Authorization: flashcourierToken
                },
                data: {
                  clienteId: Number(clientId),
                  cttId: cctIds.split(',').map((id) => Number(id.trim())),
                  numEncCli: orders.map(({ number }) => {
                    if (storeId === 51301) return `MONO-${number}`
                    return String(number)
                  })
                }
              })
              // logger.info({ hawbs })
              for (let i = 0; i.length < hawbs.length; i++) {
                const hawb = hawbs[i]
                const order = orders.find(({ number }) => {
                  return Number(hawb.codigoCartao.replace(/\D/g, '')) === number
                })
                // logger.info({ hawb, order })
                if (!order) {
                  logger.warn(`[track] cannot match order for ${JSON.stringify(hawb)}`)
                } else {
                  hawb.historico.sort((a, b) => {
                    if (a.ocorrencia && b.ocorrencia) {
                      const [aDay, aMonth, aYear, aHour, aMin] = a.ocorrencia.split(/\D/)
                      const [bDay, bMonth, bYear, bHour, bMin] = b.ocorrencia.split(/\D/)
                      if (`${aYear}${aMonth}${aDay}${aHour}${aMin}` > `${bYear}${bMonth}${bDay}${bHour}${bMin}`) {
                        return 1
                      }
                      return -1
                    }
                    return 0
                  })
                  const { eventoId } = hawb.historico[hawb.historico.length - 1]
                  let status
                  switch (eventoId) {
                    case '1100':
                      status = 'ready_for_shipping'
                      break
                    case '1400':
                    case '2000':
                    case '2200':
                    case '3000':
                    case '4100':
                      status = 'shipped'
                      break
                    case '2500':
                    case '4250':
                    case '4300':
                    case '5000':
                      status = 'delivered'
                      break
                    case '2400':
                    case '2600':
                    case '6100':
                      status = 'returned'
                      break
                  }
                  if (
                    status &&
                    (!order.fulfillment_status || order.fulfillment_status.current !== status)
                  ) {
                    await appSdk.apiRequest(storeId, `/orders/${order._id}/fulfillments.json`, 'POST', {
                      status,
                      flags: ['flashcr']
                    })
                    if (status === 'shipped') {
                      const code = hawb.codigoCartao
                      await appSdk.apiRequest(storeId, `/orders/${order._id}/shipping_lines/0.json`, 'PATCH', {
                        tracking_codes: [{
                          code,
                          link: `https://www.flashcourier.com.br/rastreio/${code}`
                        }]
                      })
                    }
                  }
                }
              }
            } catch (err) {
              logger.error(err)
            }
          }
        }
      })
      .catch(reject)
  })
}

module.exports = context => setup(null, true, firestore())
  .then(appSdk => {
    return listStoreIds().then(storeIds => {
      const runAllStores = fn => storeIds
        .sort(() => Math.random() - Math.random())
        .map(storeId => fn({ appSdk, storeId }))
      return Promise.all(runAllStores(fetchTracking))
    })
  })
  .catch(logger.error)
