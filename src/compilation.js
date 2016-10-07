import {
  print,
  visit,
  visitWithTypeInfo,
  typeFromAST,
  getNamedType,
  isAbstractType,
  isEqualType,
  isTypeSubTypeOf,
  Kind,
  TypeInfo,
  isType,
  isCompositeType,
  GraphQLEnumType,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLUnionType,
  GraphQLError
} from 'graphql';

import {
  isBuiltInType,
  isTypeProperSuperTypeOf,
  getOperationRootType,
  getFieldDef
} from './utilities/graphql';

import {
  join,
  block,
  wrap,
  indent
} from './utilities/printing';

// Parts of this code are adapted from graphql-js

export function compileToIR(schema, document) {
  const compiler = new Compiler(schema, document);

  const operations = Object.create(null);

  compiler.operations.forEach(operation => {
    operations[operation.name.value] = compiler.compileOperation(operation)
  });

  const fragments = Object.create(null);

  compiler.fragments.forEach(fragment => {
    fragments[fragment.name.value] = compiler.compileFragment(fragment)
  });

  const typesUsed = compiler.typesUsed;

  return { schema, operations, fragments, typesUsed };
}

export class Compiler {
  constructor(schema, document) {
    this.schema = schema;

    this.typesUsedSet = new Set();

    this.fragmentMap = Object.create(null);
    this.operations = [];

    for (const definition of document.definitions) {
      switch (definition.kind) {
        case Kind.OPERATION_DEFINITION:
          this.operations.push(definition);
          break;
        case Kind.FRAGMENT_DEFINITION:
          this.fragmentMap[definition.name.value] = definition;
          break;
      }
    }

    this.compiledFragmentMap = Object.create(null);
  }

  get typesUsed() {
    return Array.from(this.typesUsedSet);
  }

  fragmentNamed(fragmentName) {
    return this.fragmentMap[fragmentName];
  }

  get fragments() {
    return Object.values(this.fragmentMap);
  }

  compileOperation(operationDefinition) {
    const operationName = operationDefinition.name.value;

    const variables = operationDefinition.variableDefinitions.map(node => {
      const name = node.variable.name.value;
      const type = typeFromAST(this.schema, node.type);
      this.typesUsedSet.add(type);
      return { name, type };
    });

    const source = print(withTypenameFieldAddedWhereNeeded(this.schema, operationDefinition));

    const rootType = getOperationRootType(this.schema, operationDefinition);

    const groupedVisitedFragmentSet = new Map();
    const groupedFieldSet = this.collectFields(rootType, operationDefinition.selectionSet, undefined, groupedVisitedFragmentSet);

    const fragmentsReferencedSet = Object.create(null);
    const { fields } = this.resolveFields(rootType, groupedFieldSet, groupedVisitedFragmentSet, fragmentsReferencedSet);
    const fragmentsReferenced = Object.keys(fragmentsReferencedSet);

    return { operationName, variables, source, fields, fragmentsReferenced };
  }

  compileFragment(fragmentDefinition) {
    const fragmentName = fragmentDefinition.name.value;

    const source = print(withTypenameFieldAddedWhereNeeded(this.schema, fragmentDefinition));

    const typeCondition = typeFromAST(this.schema, fragmentDefinition.typeCondition);

    const groupedVisitedFragmentSet = new Map();
    const groupedFieldSet = this.collectFields(typeCondition, fragmentDefinition.selectionSet, undefined, groupedVisitedFragmentSet);

    const { fields, fragmentSpreads, inlineFragments } = this.resolveFields(typeCondition, groupedFieldSet, groupedVisitedFragmentSet);

    return { fragmentName, source, typeCondition, fields, fragmentSpreads, inlineFragments };
  }

  collectFields(parentType, selectionSet, groupedFieldSet = Object.create(null), groupedVisitedFragmentSet = new Map()) {
    if (!isCompositeType(parentType)) {
      throw new Error(`parentType should be a composite type, but is "${String(parentType)}"`);
    }

    for (const selection of selectionSet.selections) {
      switch (selection.kind) {
        case Kind.FIELD: {
          const fieldName = selection.name.value;
          const responseName = selection.alias ? selection.alias.value : fieldName;

          const field = getFieldDef(this.schema, parentType, selection);
          if (!field) {
            throw new GraphQLError(`Cannot query field "${fieldName}" on type "${String(parentType)}"`, [selection]);
          }
          const fieldType = field.type;

          if (groupedFieldSet) {
            if (!groupedFieldSet[responseName]) {
              groupedFieldSet[responseName] = [];
            }

            groupedFieldSet[responseName].push([parentType, { ...selection, type: fieldType }]);
          }
          break;
        }
        case Kind.INLINE_FRAGMENT: {
          const typeCondition = selection.typeCondition;
          const inlineFragmentType = typeCondition ?
            typeFromAST(this.schema, typeCondition) :
            parentType;

          this.collectFields(
            isTypeSubTypeOf(this.schema, inlineFragmentType, parentType) ? inlineFragmentType : parentType,
            selection.selectionSet,
            groupedFieldSet,
            groupedVisitedFragmentSet
          );
          break;
        }
        case Kind.FRAGMENT_SPREAD: {
          const fragmentName = selection.name.value;

          const fragment = this.fragmentNamed(fragmentName);
          if (!fragment) throw new GraphQLError(`Cannot find fragment "${fragmentName}"`);

          const typeCondition = fragment.typeCondition;
          const fragmentType = typeFromAST(this.schema, typeCondition)

          if (groupedVisitedFragmentSet) {
            let visitedFragmentSet = groupedVisitedFragmentSet.get(parentType);
            if (!visitedFragmentSet) {
              visitedFragmentSet = {};
              groupedVisitedFragmentSet.set(parentType, visitedFragmentSet);
            }

            if (visitedFragmentSet[fragmentName]) continue;
            visitedFragmentSet[fragmentName] = true;
          }

          const effectiveType = isTypeSubTypeOf(this.schema, fragmentType, parentType) ? fragmentType : parentType;

          this.collectFields(
            effectiveType,
            fragment.selectionSet,
            null,
            groupedVisitedFragmentSet
          );
          break;
        }
      }
    }

    return groupedFieldSet;
  }

  mergeSelectionSets(parentType, fieldSet, groupedVisitedFragmentSet) {
    const groupedFieldSet = Object.create(null);

    for (const [,field] of fieldSet) {
      const selectionSet = field.selectionSet;

      if (selectionSet) {
        this.collectFields(parentType, selectionSet, groupedFieldSet, groupedVisitedFragmentSet);
      }
    }

    return groupedFieldSet;
  }

  resolveFields(parentType, groupedFieldSet, groupedVisitedFragmentSet, fragmentsReferencedSet) {
    const fields = [];

    for (let [fieldName, fieldSet] of Object.entries(groupedFieldSet)) {
      fieldSet = fieldSet.filter(([typeCondition,]) => isTypeSubTypeOf(this.schema, parentType, typeCondition));
      if (fieldSet.length < 1) continue;

      const [,firstField] = fieldSet[0];
      const fieldType = firstField.type;

      let field = { name: fieldName, type: fieldType };

      const bareFieldType = getNamedType(fieldType);

      if (!isBuiltInType(bareFieldType)) {
        this.typesUsedSet.add(bareFieldType);
      }

      if (isCompositeType(bareFieldType)) {
        const subSelectionGroupedVisitedFragmentSet = new Map();
        const subSelectionGroupedFieldSet = this.mergeSelectionSets(
          bareFieldType,
          fieldSet,
          subSelectionGroupedVisitedFragmentSet
        );

        const { fields, fragmentSpreads, inlineFragments } = this.resolveFields(
          bareFieldType,
          subSelectionGroupedFieldSet,
          subSelectionGroupedVisitedFragmentSet,
          fragmentsReferencedSet
        );
        Object.assign(field, { fields, fragmentSpreads, inlineFragments });
      }

      fields.push(field);
    }

    const fragmentSpreads = this.fragmentSpreadsForParentType(parentType, groupedVisitedFragmentSet);
    const inlineFragments = this.resolveInlineFragments(parentType, groupedFieldSet, groupedVisitedFragmentSet, fragmentsReferencedSet);

    if (fragmentsReferencedSet) {
      Object.assign(fragmentsReferencedSet, ...groupedVisitedFragmentSet.values());
    }

    return { fields, fragmentSpreads, inlineFragments };
  }

  resolveInlineFragments(parentType, groupedFieldSet, groupedVisitedFragmentSet, fragmentsReferencedSet) {
    return this.collectPossibleTypes(parentType, groupedFieldSet, groupedVisitedFragmentSet).map(typeCondition => {
      const { fields, fragmentSpreads } = this.resolveFields(
        typeCondition,
        groupedFieldSet,
        groupedVisitedFragmentSet,
        fragmentsReferencedSet
      );
      return { typeCondition, fields, fragmentSpreads };
    });
  }

  collectPossibleTypes(parentType, groupedFieldSet, groupedVisitedFragmentSet) {
    if (!isAbstractType(parentType)) return [];

    const possibleTypes = new Set();

    for (const fieldSet of Object.values(groupedFieldSet)) {
      for (const [typeCondition,] of fieldSet) {
        if (this.schema.isPossibleType(parentType, typeCondition)) {
          possibleTypes.add(typeCondition);
        }
      }
    }

    // Also include type conditions for fragment spreads
    if (groupedVisitedFragmentSet) {
      for (const effectiveType of groupedVisitedFragmentSet.keys()) {
        if (this.schema.isPossibleType(parentType, effectiveType)) {
          possibleTypes.add(effectiveType);
        }
      }
    }

    return Array.from(possibleTypes);
  }

  fragmentSpreadsForParentType(parentType, groupedVisitedFragmentSet) {
    if (!groupedVisitedFragmentSet) return [];

    let fragmentSpreads = new Set();

    for (const [effectiveType, visitedFragmentSet] of groupedVisitedFragmentSet) {
      if (!isTypeProperSuperTypeOf(this.schema, effectiveType, parentType)) continue;

      for (const fragmentName of Object.keys(visitedFragmentSet)) {
        fragmentSpreads.add(fragmentName);
      }
    }

    return Array.from(fragmentSpreads);
  }
}

const typenameField = { kind: Kind.FIELD, name: { kind: Kind.NAME, value: '__typename' } };

function withTypenameFieldAddedWhereNeeded(schema, ast) {
  const typeInfo = new TypeInfo(schema);

  return visit(ast, visitWithTypeInfo(typeInfo, {
    leave: {
      SelectionSet: node => {
        const parentType = typeInfo.getParentType();

        if (isAbstractType(parentType)) {
          return { ...node, selections: [typenameField, ...node.selections] };
        }
      }
    }
  }));
}

function sourceAt(location) {
  return location.source.body.slice(location.start, location.end);
}

export function stringifyIR(ast, space) {
  return JSON.stringify(ast, function(key, value) {
    if (isType(value)) {
      return String(value);
    }
    return value;
  }, space);
}

export function printIR({ fields, inlineFragments, fragmentSpreads }) {
  return fields && wrap('<', join(fragmentSpreads, ', '), '> ')
    + block(fields.map(field =>
      `${field.name}: ${String(field.type)}` + wrap(' ', printIR(field))
    ).concat(inlineFragments && inlineFragments.map(inlineFragment =>
      `${String(inlineFragment.typeCondition)}` + wrap(' ', printIR(inlineFragment)))));
}