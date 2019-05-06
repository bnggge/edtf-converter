/**
 * @module EdtfConverter
 */

import { compact, flatten, get, isArray, isString, mergeWith, uniq, zip } from 'lodash';
import * as moment from 'moment';
import parseWords from './parse-words';
import preprocessText from './preprocess-text';

interface IEdtfPartResult {
  cleanEdtf: string;
  detectedModifiers: ICustomModifier[];
  format: 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD';
  hasOpenEnd: boolean;
  hasOpenStart: boolean;
  isApproximate: boolean;
  isUncertain: boolean;
  maxDate: moment.Moment;
  minDate: moment.Moment;
}

interface IParseEdtfResult {
  primaryPart: IEdtfPartResult;
  secondaryPart: IEdtfPartResult;
}

export interface ICustomModifier {
  keyword: string;
  modifierRegex: RegExp;
  addModifierFn: (edtf: string) => string;
  removeModifierFn: (edtf: string) => string;
}

/** Allow customizing the converters' behaviour. */
export interface IOptions {
  /** Used when converting an EDTF with the approxmiate modifier `~` to a date.
   *
   * Example: With `approximateVariance.days = 5`, the resulting min and max dates for
   * "~1930-05-03" are "1930-04-28" and "1930-05-08" respectively.
   */
  approximateVariance?: {
    /** @default 3 */
    days?: number,
    /** @default 3 */
    months?: number;
    /** @default 3 */
    years?: number;
  };
  /**
   * Allows adding custom keywords with corresponding modifier functions. If a keyword is detected,
   * it's modifier is called with the original EDTF string expecting it to return a modified EDTF
   * string.
   */
  customModifiers?: ICustomModifier[];
  /** The locales specify which words trigger a certain EDTF feature and how to parse date formats.
   * The order of the locales determines their priority while parsing.
   * @default ['en']
   */
  locales?: Array<'en' | 'fr'>;
}

const DEFAULT_OPTIONS: IOptions = {
  approximateVariance: {
    days: 3,
    months: 3,
    years: 3,
  },
  customModifiers: [],
  locales: ['en'],
};

/** An object containing the minimum and maximum date for an EDTF value */
export interface IDate {
  min: moment.Moment | null;
  max: moment.Moment | null;
}

/** Class representing a converter. */
export class Converter {
  private localeData: any;
  private _options: IOptions;

  /** Get the current options or update them for all subsequent operations. */
  set options(value: IOptions) {
    this._options = {...DEFAULT_OPTIONS, ...value};
  }
  get options(): IOptions {
    return this._options;
  }

  /** Initialize the options for the converter. */
  constructor(options?: IOptions) {
    this.options = options || {};
    const localeNames = this.options.locales || [];
    const locales = localeNames.map((locale) => {
      try {
        return require(`./i18n/${locale}.json`);
      } catch (error) {
        throw new Error(`Locale "${locale}" is not supported.`);
      }
    });
    this.localeData = mergeWith({}, ...locales, (objValue: any, srcValue: any) => {
      if (isArray(objValue)) {
        return uniq(compact(flatten(zip(objValue, srcValue))));
      } else if (isString(objValue)) {
        return [objValue, srcValue];
      }
    });
  }

  /**
   * Converts natural language to an EDTF compliant date string.
   */
  public textToEdtf(input: string): string {
    // Prepare input for parsing
    input = preprocessText(input);

    // Split input into array of words
    const words = input.split(/\s/);

    // Try to find delimiter and separate start and end of input
    const localeDelimiters =
        get(this.localeData, 'keywords.interval.delimiters') || [];
    const delimiters = ['-', '–', ...localeDelimiters];
    let delimiterIndex = words
        .slice(1, -1) // Don't look for delimiter in first or last word
        .findIndex((word) => delimiters.includes(word));
    delimiterIndex = delimiterIndex === -1 ? -1 : delimiterIndex + 1;
    let startWords: string[];
    let endWords: string[];
    if (delimiterIndex > -1) {
      startWords = words.slice(0, delimiterIndex);
      endWords = words.slice(delimiterIndex + 1);
    } else {
      startWords = words;
      endWords = [];
    }

    // Parse words to EDTF string
    let edtf = parseWords(startWords, this.options, this.localeData);
    if (endWords.length) {
      const endEdtf = parseWords(endWords, this.options, this.localeData);
      edtf += `/${endEdtf}`;
    }

    return edtf;
  }

  /**
   * Converts an EDTF compliant date string to natural language.
   */
  public edtfToText(edtf: string): string {
    const parseResult = this.parseEdtf(edtf);
    return [parseResult.primaryPart, parseResult.secondaryPart]
      .map((partResult) => {
        if (!partResult) {
          return null;
        }
        const textArray: string[] = [];
        partResult.detectedModifiers.forEach((modifier) => {
          textArray.push(modifier.keyword);
        });
        if (partResult.hasOpenEnd) {
          textArray.push(this.localeData.keywords.interval.openEnd[0]);
        }
        if (partResult.hasOpenStart) {
          textArray.push(this.localeData.keywords.interval.openStart[0]);
        }
        if (partResult.isUncertain) {
          textArray.push(this.localeData.keywords.uncertain[0]);
        }
        if (partResult.isApproximate) {
          textArray.push(this.localeData.keywords.approximate[0]);
        }
        const primaryDateFormat = this.localeData.dateFormats[0];
        const dateText = moment(partResult.cleanEdtf, partResult.format).format(primaryDateFormat);
        textArray.push(dateText);
        return textArray.join(' ');
      })
      .filter((part) => !!part)
      .join(` ${this.localeData.keywords.interval.delimiters[0]} `);
  }

  /**
   * Converts an EDTF date string to `min` and `max` Moment.js dates (UTC)
   */
  public edtfToDate(edtf: string): IDate {
    const parseResult = this.parseEdtf(edtf);
    let min: moment.Moment | null = null;
    let max: moment.Moment | null = null;
    if (parseResult.primaryPart.hasOpenStart) {
      max = parseResult.primaryPart.maxDate;
    } else if (parseResult.primaryPart.hasOpenEnd) {
      min = parseResult.primaryPart.minDate;
    } else {
      min = parseResult.primaryPart.minDate;
      if (parseResult.secondaryPart) {
        max = parseResult.secondaryPart.maxDate;
      } else {
        max = parseResult.primaryPart.maxDate;
      }
    }
    return {min, max};
  }

  /** Checks whether a given EDTF is valid
   *  @throws {Error} Error thrown if invalid
   *  @see {@link https://github.com/simon-mathewson/edtf-converter#compatibility | Compatibility}
   */
  public validateEdtf(edtf: string) {
    const edtfArray = edtf.split('/');
    this.validateEdtfPart(edtfArray[0]);
    if (edtfArray[1]) {
      this.validateEdtfPart(edtfArray[1]);
    }
  }

  private validateEdtfPart(edtf: string) {
    const modifier = String.raw`([?~%])`;
    const date = String.raw`[0-9]{4}(-(0[1-9]|1[0-2])(-([0-2][1-9]|3[0-1]))?)?`;
    const edtfSection = String.raw`(${modifier}?\s*${date}\s*${modifier}?)`;
    const openStart = String.raw`(\[(\s*\.\.)?)`;
    const openEnd = String.raw`((\.\.\s*)?])`;
    const edtfRegex =
        String.raw`^\s*${openStart}?\s*${edtfSection}\s*(\/\s*${edtfSection}|${openEnd}?)?\s*$`;
    if (!new RegExp(edtfRegex).test(edtf)) {
      throw new Error(
        `Invalid EDTF: "${edtf}" is not EDTF compliant or contains unsupported features.`,
      );
    }
  }

  /**
   * Parses an EDTF to a result object containing information about it's modifiers and dates
   */
  public parseEdtf(edtf: string): IParseEdtfResult {
    // Split edtf into parts to process separately
    const edtfArray = edtf.split('/');
    const [primaryPart, secondaryPart] = edtfArray.map((edtfPart) => {
      // Init result object
      const result: Partial<IEdtfPartResult> = {
        detectedModifiers: [],
      };
      // Detect and remove custom modifiers
      this.options.customModifiers!.forEach((modifier) => {
        if (modifier.modifierRegex.test(edtfPart)) {
          result.detectedModifiers!.push(modifier);
          edtfPart = modifier.removeModifierFn(edtfPart);
        }
      });
      // Validate input
      this.validateEdtfPart(edtfPart);
      // Find modifiers
      result.isApproximate = /[~%]/g.test(edtfPart);
      result.isUncertain = /[\?%]/g.test(edtfPart);
      result.hasOpenStart = /^\[\s*\.\./.test(edtfPart);
      result.hasOpenEnd = /\.\.\s*]$/.test(edtfPart);
      // Remove modifiers and whitespace from string
      result.cleanEdtf = edtfPart.replace(/[\[\.\[\]\?~%\s]/g, '');
      // Determine the format
      let unit: 'year' | 'month' | 'day';
      let variance: number;
      if (result.cleanEdtf.length === 4) {
        result.format = 'YYYY';
        unit = 'year';
        variance = this.options!.approximateVariance!.years as number;
      } else if (result.cleanEdtf.length === 7) {
        result.format = 'YYYY-MM';
        unit = 'month';
        variance = this.options!.approximateVariance!.months as number;
      } else {
        result.format = 'YYYY-MM-DD';
        unit = 'day';
        variance = this.options!.approximateVariance!.days as number;
      }
      // Init date variables
      result.minDate = moment.utc(result.cleanEdtf, result.format);
      result.maxDate = moment.utc(result.cleanEdtf, result.format);
      // Apply variance if approximate
      if (result.isApproximate) {
        result.minDate.subtract(variance, unit);
        result.maxDate.add(variance, unit);
      }
      // Set dates to minimum and maximum possible value
      result.minDate.startOf(unit);
      result.maxDate.endOf(unit);
      return result as IEdtfPartResult;
    });
    return { primaryPart, secondaryPart };
  }
}
