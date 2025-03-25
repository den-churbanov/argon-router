import { ParseUrlParams } from './types';

type RawRules = {
  required: boolean;
  type: 'string' | 'number' | { type: 'union'; values: string[] };
  array?: { minLength?: number; maxLength?: number };
};

type UrlControls = {
  getInput: (input?: string) => string | void;
  next: () => void;
};

type Validator = (props: UrlControls) => boolean;
type Parser = (props: UrlControls) => any;

type Block =
  | {
      type: 'parameter';
      name: string;
      validator: Validator;
      parser: Parser;
      required: boolean;
    }
  | { type: 'part'; value: string };

function createControls(blocks: any[], startPosition: number): UrlControls {
  let i = startPosition;
  let current = blocks[startPosition];

  return {
    getInput: () => current,
    next: () => {
      i++;
      current = blocks[i];
    },
  };
}

function generateValidator(rules: RawRules): Validator {
  function baseValidator(input?: string) {
    if (rules.required && !input) {
      return false;
    }

    if (!input) {
      return true;
    }

    if (typeof rules.type === 'object') {
      switch (rules.type.type) {
        case 'union': {
          return rules.type.values.includes(input);
        }
      }
    }

    switch (rules.type) {
      case 'number': {
        return !isNaN(parseInt(input));
      }
      case 'string': {
        return true;
      }
    }
  }

  return ({ getInput, next }) => {
    if (rules.array) {
      const { minLength, maxLength } = rules.array;

      let current;
      const result: any[] = [];

      while (
        (current = getInput()) &&
        result.length < (maxLength ?? Infinity)
      ) {
        if (!baseValidator(current)) {
          return false;
        }

        result.push(true);
        next();
      }

      if (
        result.length > (maxLength ?? Infinity) ||
        result.length < (minLength ?? 0)
      ) {
        return false;
      }

      return true;
    }

    const input = getInput();

    if (rules.required && !input) {
      return false;
    }

    if (!input) {
      return true;
    }

    return baseValidator(input);
  };
}

function generateParser(rules: RawRules): Parser {
  function baseParser(input?: string) {
    if (rules.required && !input) {
      return null;
    }

    if (!input) {
      return undefined;
    }

    if (rules.type === 'number') {
      return parseInt(input);
    }

    return input;
  }

  return ({ getInput, next }) => {
    const input = getInput();

    if (rules.array) {
      const { minLength, maxLength } = rules.array;

      let current;

      const result: any[] = [];

      while (
        (current = getInput()) &&
        result.length < (maxLength ?? Infinity)
      ) {
        result.push(baseParser(current));
        next();
      }

      if (
        result.length > (maxLength ?? Infinity) ||
        result.length < (minLength ?? 0)
      ) {
        return undefined;
      }

      return result;
    }

    if (rules.required && !input) {
      return null;
    }

    if (!input) {
      return undefined;
    }

    return baseParser(input);
  };
}

type CompileResult<Params> = {
  parse(input: string): { path: string; params: Params } | null;
  build(params: Params): string;
};

export function compile<T extends string, Params = ParseUrlParams<T>>(
  path: T,
): CompileResult<Params> {
  const blocks: Block[] = [];

  const regexp = /:(\w+)(<[\w|]+>)?([+*?])?/;

  const parsedBlocks = path.split('/').filter(Boolean);

  for (let i = 0; i < parsedBlocks.length; i++) {
    const block = parsedBlocks[i];

    if (!block) {
      continue;
    }

    const matches = block.match(regexp);

    if (!matches) {
      blocks.push({ type: 'part', value: block });

      continue;
    }

    const name = matches[1];
    const generic = matches[2];
    const modificator = matches[3];

    if (!name) {
      throw new Error(
        `Invalid path: "${path}". Name for argument must be provided`,
      );
    }

    const rules: RawRules = {
      required: true,
      type: 'string',
    };

    if (generic) {
      const type = generic.replace('<', '').replace('>', '');

      if (type === 'number') {
        rules.type = 'number';
      }

      if (type.includes('|')) {
        rules.type = {
          type: 'union',
          values: type.split('|').filter(Boolean),
        };
      }
    }

    switch (modificator) {
      case '*': {
        rules.array = {};
        break;
      }
      case '+': {
        rules.array = { minLength: 1 };
        break;
      }
      case '?': {
        rules.required = false;
        break;
      }
    }

    blocks.push({
      type: 'parameter',
      name,
      required: rules.required,
      validator: generateValidator(rules),
      parser: generateParser(rules),
    });
  }

  function stringifyParam(param: unknown): string {
    if (Array.isArray(param)) {
      return param.length === 0
        ? ''
        : param.map((item) => stringifyParam(item)).join('/');
    }

    if (typeof param === 'object') {
      throw new Error("Paths doesn't support object parameters");
    }

    if (!param) {
      return '';
    }

    return param.toString();
  }

  return {
    /**
     * @param input input path
     * @returns `{ path: string; params: Params }` | `null`
     */
    parse(input: string): { path: string; params: Params } | null {
      const parsed = decodeURI(input).split('/').filter(Boolean);
      let params: any = null;

      for (let i = 0; i < blocks.length; i++) {
        const compiledBlock = blocks[i];
        const rawBlock = parsed[i];

        if (compiledBlock.type === 'part') {
          if (compiledBlock.value !== rawBlock) {
            return null;
          }

          continue;
        }

        if (!compiledBlock.validator(createControls(parsed, i))) {
          return null;
        }

        const parsedPayload = compiledBlock.parser(createControls(parsed, i));

        if (parsedPayload === null) {
          return null;
        }

        if (!params) {
          params = {};
        }

        params[compiledBlock.name] = parsedPayload;
      }

      return { path: input, params };
    },

    build(params: Params): string {
      const anyParams = params as any;

      const result: string[] = [];

      for (const block of blocks) {
        if (block.type === 'part') {
          result.push(block.value);
          continue;
        }

        if (!anyParams[block.name] && block.required) {
          throw new Error(
            `Cannot build path without required parameter: "${block.name}"`,
          );
        }

        if (!anyParams[block.name] && !block.required) {
          continue;
        }

        result.push(stringifyParam(anyParams[block.name]));
      }

      return encodeURI(`/${result.filter(Boolean).join('/')}`);
    },
  };
}
