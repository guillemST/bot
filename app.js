import ccxt from 'ccxt';
import fs from 'fs';
import selfcore from 'selfcore';// Configura las credenciales y datos necesarios

const apiKey = 'REyr2cq3ezQ0UQX5Hb37NzPzjXWCvBwOlHu8VFl5jcHYiKImtzIys9XtHz1b9BDJtgkzEBqtwv80zfB9g';
const secret = 'sAbLzvq6cejJhVCIDfA7gKmFOEPBIAhpBBN0E7gNvFZODD7LoCvWlgYuMQkr8lViEnUcMturdcSEW3qpNQ';
const exchangeId = 'bingx'; // ID del intercambio que estás utilizando

const exchange = new ccxt[exchangeId]({
    apiKey,
    secret,
    options: {
        'defaultType': 'future', // Asegúrate de configurar el tipo correcto (spot, future, etc.)
        'adjustForTimeDifference': true,
    }
});

const client = new selfcore();
const gateway = new selfcore.Gateway("Mzg2OTUxMTM2MTcyNTcyNjcz.G0ne5g.XmJcg8m6iWib6Ome-e5ZXjPSYzzVOAJv6LfrJI");

gateway.on("message", async (m) => {
  try {
    if (m.channel_id == "1090187274286809158") {
      const content = m.embeds[0];
      const contentString = JSON.stringify(content);

      try {
        await fs.promises.writeFile('jasonbueno.json', contentString);
        console.log('El archivo "jasonbueno.json" ha sido creado exitosamente.');

        setTimeout(async () => {
          try {
            const data = await fs.promises.readFile('jasonbueno.json', 'utf-8');
            const content = JSON.parse(data);

            if (!content || !Array.isArray(content.fields)) {
              throw new Error('El mensaje de Discord no tiene la estructura esperada.');
            }

            let symbol = '';
            let tpPrice = null;
            let slPrice = null;
            let entryPrice = null;
            
            const fields = content.fields;
            for (let i = 0; i < fields.length; i++) {
              const field = fields[i];
              const fieldValue = field.value;

              if (fieldValue.includes('https://www.binance.com') || fieldValue.includes('https://futures.binance.com')) {
                const symbolMatch = fieldValue.match(/\[([A-Za-z]+)\]/);
                if (symbolMatch) {
                  symbol = symbolMatch[1].toUpperCase() + '/USDT:USDT';
                }
              }

              if (field.name === '**Tp Price**') {
                tpPrice = parseFloat(field.value.replace(/[^\d.-]/g, ''));
              }
              if (field.name === '**Sl Price**') {
                slPrice = parseFloat(field.value.replace(/[^\d.-]/g, ''));
              }
              if (field.name === '**PRICE**') {
                entryPrice = parseFloat(field.value.replace(/[^\d.-]/g, ''));
              }
            }

            if (!symbol) {
              throw new Error('No se encontró el par de trading en el mensaje de Discord.');
            }

            if (!entryPrice || !tpPrice || !slPrice) {
              throw new Error('No se encontraron los precios de entrada, TP o SL en el mensaje de Discord.');
            }

            const operationField = content.author.name;
            const operation = operationField.includes('LONG') ? 'buy' : 'sell';
            console.log(operation);

            await exchange.loadMarkets(); // Cargar mercados para obtener la precisión del símbolo
            const market = exchange.markets[symbol];
            if (!market) {
              throw new Error('El mercado para el símbolo especificado no se encontró.');
            }

            const price = entryPrice; // Usar el precio de entrada directamente del mensaje
            const tpTriggerPx = tpPrice;
            const slTriggerPx = slPrice;

            console.log('Símbolo:', symbol);
            console.log('Operación:', operation);
            console.log('Precio de entrada:', price);
            console.log('Stop Loss:', slTriggerPx);
            console.log('Take Profit:', tpTriggerPx);

            // Obtener el saldo total en USDT
            const balance = await exchange.fetchBalance();
            const usdtBalance = balance.total['USDT'];
            console.log(balance);

            // Calcula la cantidad a utilizar en la operación en la moneda base del par de trading
            let amount = (usdtBalance) / price; // Ajusta el 0.1 según tu estrategia de gestión de riesgo

            // Ajustar la cantidad a la precisión mínima requerida por el mercado
            amount = exchange.amount_to_precision(symbol, amount);

            console.log('Cantidad calculada:', amount);

            // Establecer apalancamiento (si aplica)
            const leverageSide = operation === 'buy' ? 'LONG' : 'SHORT';
            await exchange.setLeverage(1, symbol, { 'side': leverageSide });

            // Crear la orden de mercado
            const params = {
              'reduceOnly': false, // Ajusta según sea necesario
            };
            const order = await exchange.createOrder(symbol, 'market', operation, amount, undefined, params);
            console.log('Orden enviada al exchange:', order);

            // Monitorear el precio actual del símbolo y terminar la orden si alcanza el nivel de stop o take profit
            const stopPriceReached = await monitorPrice(symbol, slTriggerPx, tpTriggerPx, operation);
            if (stopPriceReached) {
              console.log('El precio alcanzó el nivel de stop o take profit. Cerrando la posición...');
              await closePosition(symbol, operation);
            }
          } catch (error) {
            console.log('Error al procesar el archivo JSON:', error.message);
          }
        }, 1000);
      } catch (error) {
        console.log('Error al escribir en el archivo:', error);
      }
    }
  } catch (error) {
    console.log('Error en la función gateway.on("message"):', error.message);
  }
});

async function monitorPrice(symbol, stopPrice, takeProfitPrice, operation) {
  let priceReached = false;
  while (!priceReached) {
    const ticker = await exchange.fetchTicker(symbol);
    const currentPrice = ticker.last;

    if ((operation === 'buy' && currentPrice <= stopPrice) || (operation === 'sell' && currentPrice >= stopPrice)) {
      priceReached = true;
    } else if ((operation === 'buy' && currentPrice >= takeProfitPrice) || (operation === 'sell' && currentPrice <= takeProfitPrice)) {
      priceReached = true;
    }

    // Esperar 1 segundo antes de verificar el precio nuevamente
    await sleep(1000);
  }

  return priceReached;
}

async function closePosition(symbol, operation) {
  try {
    await exchange.loadMarkets();

    // Obtener todas las posiciones abiertas para el símbolo dado
    const positions = await exchange.fetchPositions([symbol]);

    if (positions.length > 0) {
      const position = positions[0];
      const amount = position.contracts;
      const side = position.side === 'long' ? 'sell' : 'buy';

      // Crear una orden de mercado para cerrar la posición
      const closeOrder = await exchange.createOrder(symbol, 'market', side, amount, undefined, { reduceOnly: true });
      console.log('Posición cerrada:', closeOrder);
    } else {
      console.log('No hay posiciones abiertas para cerrar.');
    }
  } catch (error) {
    console.error('Error al cerrar la posición:', error);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}