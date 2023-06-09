const axios = require('axios')

const deadlineRanges = [
  require('../../../lib/jadlog-deadlines/range-0'),
  require('../../../lib/jadlog-deadlines/range-1'),
  require('../../../lib/jadlog-deadlines/range-2'),
  require('../../../lib/jadlog-deadlines/range-3'),
  require('../../../lib/jadlog-deadlines/range-4'),
  require('../../../lib/jadlog-deadlines/range-5'),
  require('../../../lib/jadlog-deadlines/range-6'),
  require('../../../lib/jadlog-deadlines/range-7'),
  require('../../../lib/jadlog-deadlines/range-8'),
  require('../../../lib/jadlog-deadlines/range-9')
]
const getDeadline = (originZip, destinationZip, isExpress = false) => {
  const range = deadlineRanges[parseInt(originZip.charAt(0), 10)]
  let days = range(Number(destinationZip), isExpress)
  if (originZip > 19999999 && Math.abs(originZip - destinationZip) > 4000000) {
    days += (isExpress ? 1 : 2)
  }
  return days
}

exports.post = async ({ appSdk }, req, res) => {
  const { params, application } = req.body
  // const { storeId } = req
  // setup basic required response object
  const response = {
    shipping_services: []
  }
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)

  if (appData.free_shipping_from_value >= 0) {
    response.free_shipping_from_value = appData.free_shipping_from_value
  }
  if (!params.to) {
    // just a free shipping preview with no shipping address received
    // respond only with free shipping option
    res.send(response)
    return
  }

  const flashcourierKey = appData.flashcourier_contract && appData.flashcourier_contract.key
  if (!flashcourierKey) {
    return res.status(409).send({
      error: 'CALCULATE_AUTH_ERR',
      message: 'Key unset on app hidden data (merchant must configure the app)'
    })
  }

  if (appData.free_shipping_from_value >= 0) {
    response.free_shipping_from_value = appData.free_shipping_from_value
  }

  const destinationZip = params.to ? params.to.zip.replace(/\D/g, '') : ''
  const originZip = params.from
    ? params.from.zip.replace(/\D/g, '')
    : appData.zip ? appData.zip.replace(/\D/g, '') : ''
  if (!originZip) {
    return res.status(409).send({
      error: 'CALCULATE_ERR',
      message: 'Zip code is unset on app hidden data (merchant must configure the app)'
    })
  }

  if (params.items) {
    // calculate weight and pkg value from items list
    let finalWeight = 0
    params.items.forEach(({ price, quantity, dimensions, weight }) => {
      let physicalWeight = 0
      let cubicWeight = 1

      // sum physical weight
      if (weight && weight.value) {
        switch (weight.unit) {
          case 'kg':
            physicalWeight = weight.value
            break
          case 'g':
            physicalWeight = weight.value / 1000
            break
          case 'mg':
            physicalWeight = weight.value / 1000000
        }
      }

      // sum total items dimensions to calculate cubic weight
      if (dimensions) {
        const sumDimensions = {}
        for (const side in dimensions) {
          const dimension = dimensions[side]
          if (dimension && dimension.value) {
            let dimensionValue
            switch (dimension.unit) {
              case 'cm':
                dimensionValue = dimension.value
                break
              case 'm':
                dimensionValue = dimension.value * 100
                break
              case 'mm':
                dimensionValue = dimension.value / 10
            }
            // add/sum current side to final dimensions object
            if (dimensionValue) {
              sumDimensions[side] = sumDimensions[side]
                ? sumDimensions[side] + dimensionValue
                : dimensionValue
            }
          }
        }

        // calculate cubic weight
        // https://suporte.boxloja.pro/article/82-correios-calculo-frete
        // (C x L x A) / 6.000
        for (const side in sumDimensions) {
          if (sumDimensions[side]) {
            cubicWeight *= sumDimensions[side]
          }
        }
        if (cubicWeight > 1) {
          cubicWeight /= 6000
        }
      }
      finalWeight += (quantity * (physicalWeight > cubicWeight ? physicalWeight : cubicWeight))
    })

    // https://www.flashcalculador-sp.com.br/documentacao-api
    const flashcourierUrl = 'https://www.flashcalculador-sp.com.br/api/v2/calcular_frete' +
      `?cep_destino=${destinationZip}` +
      `&peso_gramas=${(finalWeight ? finalWeight * 1000 : 100)}` +
      `&cliente_chave=${flashcourierKey}`
    let flashcourierResult
    try {
      flashcourierResult = (await axios(flashcourierUrl)).data
    } catch (err) {
      let { message } = err
      if (err.response && err.response.data && err.response.data.message) {
        message = err.response.data.message
      }
      // console.warn(`[calc] failed ${flashcourierUrl}`)
      return res.status(409).send({
        error: 'CALCULATE_FAILED_WS',
        message
      })
    }
    if (!flashcourierResult || !Array.isArray(flashcourierResult.products)) {
      return res.status(409).send({
        error: 'CALCULATE_FAILED_EMPTY',
        message: 'Flash Courier API doesnt return valid result'
      })
    }

    flashcourierResult.products.forEach((flashcourierProduto) => {
      Object.keys(flashcourierProduto).forEach(label => {
        let price, days
        if (typeof flashcourierProduto[label] === 'object') {
          price = parseFloat(flashcourierProduto[label].preco)
          const minDays = parseInt(flashcourierProduto[label].prazo_min, 10)
          const maxDays = parseInt(flashcourierProduto[label].prazo_max, 10)
          days = Math.ceil((minDays + maxDays) / 2)
        } else {
          price = parseFloat(flashcourierProduto[label])
        }
        if (Array.isArray(appData.services) && appData.services.length) {
          const service = appData.services.find((service) => label === service.service_code)
          if (service) {
            label = service.label || label
          } else {
            return
          }
        }
        const shippingLine = {
          from: {
            ...params.from,
            zip: originZip
          },
          to: params.to,
          price,
          total_price: price,
          discount: 0,
          delivery_time: {
            days,
            working_days: true
          },
          posting_deadline: {
            days: 1,
            ...appData.posting_deadline
          },
          package: {
            weight: {
              value: finalWeight,
              unit: 'kg'
            }
          },
          flags: ['flashcr-ws']
        }
        if (appData.additional_price) {
          if (appData.additional_price > 0) {
            shippingLine.other_additionals = [{
              tag: 'additional_price',
              label: 'Adicional padrão',
              price: appData.additional_price
            }]
          } else {
            shippingLine.discount -= appData.additional_price
          }
          shippingLine.total_price += appData.additional_price
          if (shippingLine.total_price < 0) {
            shippingLine.total_price = 0
          }
        }
        response.shipping_services.push({
          label,
          shipping_line: shippingLine
        })
      })
    })

    response.shipping_services.sort((a, b) => {
      if (a.price > b.price) {
        return 1
      }
      return -1
    })
    response.shipping_services.forEach((service, i) => {
      if (!service.shipping_line.delivery_time.days) {
        // express deadline on first (cheaper) service
        const isExpress = response.shipping_services.length > 1 && i === 0
        service.shipping_line.delivery_time.days = getDeadline(originZip, destinationZip, isExpress)
        if (i > 1) {
          service.shipping_line.delivery_time.days += (i - 1)
        }
      }
    })
  } else {
    res.status(400).send({
      error: 'CALCULATE_EMPTY_CART',
      message: 'Cannot calculate shipping without cart items'
    })
  }

  res.send(response)
}
