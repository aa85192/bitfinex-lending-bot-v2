import _ from 'lodash'
import { dayjs } from './dayjs.mjs'
import JSON5 from 'json5'
import jsyaml from 'js-yaml'

export function json5parseOrDefault (json5, defaultVal) {
  try {
    return _.isString(json5) ? JSON5.parse(json5) : defaultVal
  } catch (err) {
    return defaultVal
  }
}

export function floatFormatDecimal (num, precision = 2) {
  const formater = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision,
    style: 'decimal',
  })
  return formater.format(num)
}

export function floatFormatPercent (rate, precision = 2) {
  const formater = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision,
    style: 'percent',
  })
  return formater.format(rate)
}

export function rateStringify (rate) {
  return `${floatFormatPercent(rate, 6)} (APR: ${floatFormatPercent(rate * 365)})`
}

export function dateStringify (date) {
  return dayjs(date).format('YYYY-MM-DD HH:mm:ssZ')
}

export function floatIsEqual (float1, float2) {
  return Math.abs(float1 - float2) < Number.EPSILON
}

export function progressPercent (val, total) {
  if (total === 0) {
    return floatFormatPercent(0)
  }
  return floatFormatPercent(val / total)
}

export function floatFloor8 (num) {
  return Math.floor(num * 100000000) / 100000000
}

export function parseYaml (str) {
  return jsyaml.load(str, { json: true, schema: jsyaml.JSON_SCHEMA })
}
