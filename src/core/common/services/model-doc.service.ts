import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import fs = require('fs');
import { Connection } from 'mongoose';
import YumlDiagram = require('yuml-diagram');

/**
 * Schema config for yUml creation
 */
export interface ModelDocSchemaConfig {
  isArray: boolean;
  name: string;
  ref: string;
  type: string;
}

/**
 * Model documentation as yUML-SVG
 */
@Injectable()
export class ModelDocService implements OnApplicationBootstrap {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /**
   * Lifecycle hook that is called right after the application has started.
   */
  async onApplicationBootstrap() {
    const schemaJson = this.getSchemaJson();
    const yUml = this.jsonToYuml(schemaJson);
    this.yUmlToSvg(yUml);
  }

  /**
   * Analyse the mongoose database models and create JSON
   * @protected
   */
  protected getSchemaJson(): Record<string, Record<string, ModelDocSchemaConfig>> {
    // Prepare results
    const results: Record<string, Record<string, ModelDocSchemaConfig>> = {};

    // Process models
    const models = this.connection.modelNames();
    for (const modelName of models) {
      results[modelName] = {};

      // Process schema
      const schema = this.connection.model(modelName).schema;
      Object.keys(schema.paths).forEach((key) => {
        const obj: any = schema.obj[key] || {};
        const path = schema.paths[key];

        results[modelName][key] = {
          isArray: path.instance === 'Array',
          name: path.path,
          ref: Array.isArray(obj) ? undefined : obj.ref,
          type:
            path.instance === 'Array'
              ? Array.isArray(obj)
                ? obj[0]() === ''
                  ? 'String'
                  : obj[0]()
                : typeof obj.type === 'function'
                  ? obj.type.name
                  : 'unknown'
              : path.instance,
        };
        if (results[modelName][key].type === 'Mixed') {
          results[modelName][key].type = 'JSON';
        }
      });
    }

    // Return results
    return results;
  }

  /**
   * Convert JSON to yUML
   * @param json
   * @protected
   */
  protected jsonToYuml(json: Record<string, Record<string, ModelDocSchemaConfig>>) {
    // Convert JSON to yUML
    let yumlText = '// {type:class}';
    for (const [modelName, properties] of Object.entries(json)) {
      yumlText += `\n[${modelName} | `;
      const refs = [];
      let subYumlText = '';
      for (const [key, value] of Object.entries(properties)) {
        let type = value.type;
        if (value.isArray) {
          type = `Array<${type}>`;
        }
        if (value.ref) {
          refs.push(`[${modelName}]-${key}>[${value.ref}]`);
        }
        if (key.startsWith('__')) {
          continue;
        }
        if (key === '_id') {
          subYumlText = `id: ObjectId; ${subYumlText}`;
          continue;
        }
        subYumlText += `${key}: ${type}; `;
      }
      yumlText += `${subYumlText}]\n`;
      for (const ref of refs) {
        yumlText += `${ref}\n`;
      }
    }
    return yumlText;
  }

  /**
   * Convert yUML to SVG
   * @param yUmlText
   * @protected
   */
  protected yUmlToSvg(yUmlText: string) {
    // Create diagrams
    // see https://github.com/jaime-olivares/yuml-diagram
    // and https://yuml.me/diagram/scruffy/class/samples
    const yuml = new YumlDiagram();
    const svgLightBg = yuml.processYumlDocument(yUmlText, false);
    const svgDarkBg = yuml.processYumlDocument(yUmlText, true);

    // Save yuml document
    fs.writeFile('model-doc.yuml', yUmlText, (err) => {
      if (err) {
        console.error(err);
      }
    });

    // Save diagrams
    fs.writeFile('model-doc-light.svg', svgLightBg, (err) => {
      if (err) {
        console.error(err);
      }
    });
    fs.writeFile('model-doc-dark.svg', svgDarkBg, (err) => {
      if (err) {
        console.error(err);
      }
    });
  }
}
