import _ from 'lodash';
import LogAnalyticsQuerystringBuilder from '../log_analytics/querystring_builder';
import ResponseParser from './response_parser';
import { AzureMonitorQuery, AzureDataSourceJsonData, AzureLogsVariable } from '../types';
import { TimeSeries, toDataFrame } from '@grafana/data';
import { DataQueryRequest, DataQueryResponseData, DataSourceInstanceSettings } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { TemplateSrv } from 'app/features/templating/template_srv';

export default class AzureLogAnalyticsDatasource {
  id: number;
  url: string;
  baseUrl: string;
  applicationId: string;
  azureMonitorUrl: string;
  defaultOrFirstWorkspace: string;
  subscriptionId: string;

  /** @ngInject */
  constructor(
    private instanceSettings: DataSourceInstanceSettings<AzureDataSourceJsonData>,
    private templateSrv: TemplateSrv
  ) {
    this.id = instanceSettings.id;

    switch (this.instanceSettings.jsonData.cloudName) {
      case 'govazuremonitor': // Azure US Government
        this.baseUrl = '/govloganalyticsazure';
        break;
      case 'germanyazuremonitor': // Azure Germany
        break;
      case 'chinaazuremonitor': // Azure China
        this.baseUrl = '/chinaloganalyticsazure';
        break;
      default:
        // Azure Global
        this.baseUrl = '/loganalyticsazure';
    }

    this.url = instanceSettings.url;
    this.defaultOrFirstWorkspace = this.instanceSettings.jsonData.logAnalyticsDefaultWorkspace;

    this.setWorkspaceUrl();
  }

  isConfigured(): boolean {
    return (
      (!!this.instanceSettings.jsonData.logAnalyticsSubscriptionId &&
        this.instanceSettings.jsonData.logAnalyticsSubscriptionId.length > 0) ||
      !!this.instanceSettings.jsonData.azureLogAnalyticsSameAs
    );
  }

  setWorkspaceUrl() {
    if (!!this.instanceSettings.jsonData.subscriptionId || !!this.instanceSettings.jsonData.azureLogAnalyticsSameAs) {
      this.subscriptionId = this.instanceSettings.jsonData.subscriptionId;
      const azureCloud = this.instanceSettings.jsonData.cloudName || 'azuremonitor';
      this.azureMonitorUrl = `/${azureCloud}/subscriptions`;
    } else {
      this.subscriptionId = this.instanceSettings.jsonData.logAnalyticsSubscriptionId;

      switch (this.instanceSettings.jsonData.cloudName) {
        case 'govazuremonitor': // Azure US Government
          this.azureMonitorUrl = `/govworkspacesloganalytics/subscriptions`;
          break;
        case 'germanyazuremonitor': // Azure Germany
          break;
        case 'chinaazuremonitor': // Azure China
          this.azureMonitorUrl = `/chinaworkspacesloganalytics/subscriptions`;
          break;
        default:
          // Azure Global
          this.azureMonitorUrl = `/workspacesloganalytics/subscriptions`;
      }
    }
  }

  getWorkspaces(subscription: string): Promise<AzureLogsVariable[]> {
    const subscriptionId = this.templateSrv.replace(subscription || this.subscriptionId);

    const workspaceListUrl =
      this.azureMonitorUrl +
      `/${subscriptionId}/providers/Microsoft.OperationalInsights/workspaces?api-version=2017-04-26-preview`;
    return this.doRequest(workspaceListUrl).then((response: any) => {
      return (
        _.map(response.data.value, val => {
          return { text: val.name, value: val.properties.customerId };
        }) || []
      );
    });
  }

  getSchema(workspace: string) {
    if (!workspace) {
      return Promise.resolve();
    }
    const url = `${this.baseUrl}/${this.templateSrv.replace(workspace, {})}/metadata`;

    return this.doRequest(url).then((response: any) => {
      return new ResponseParser(response.data).parseSchemaResult();
    });
  }

  async query(options: DataQueryRequest<AzureMonitorQuery>) {
    const queries = _.filter(options.targets, item => {
      return item.hide !== true;
    }).map(target => {
      const item = target.azureLogAnalytics;

      let workspace = this.templateSrv.replace(item.workspace, options.scopedVars);

      if (!workspace && this.defaultOrFirstWorkspace) {
        workspace = this.defaultOrFirstWorkspace;
      }

      const subscriptionId = this.templateSrv.replace(target.subscription || this.subscriptionId, options.scopedVars);
      const query = this.templateSrv.replace(item.query, options.scopedVars, this.interpolateVariable);

      return {
        refId: target.refId,
        intervalMs: options.intervalMs,
        maxDataPoints: options.maxDataPoints,
        datasourceId: this.id,
        format: target.format,
        queryType: 'Azure Log Analytics',
        subscriptionId: subscriptionId,
        azureLogAnalytics: {
          resultFormat: item.resultFormat,
          query: query,
          workspace: workspace,
        },
      };
    });

    if (!queries || queries.length === 0) {
      return [];
    }

    const { data } = await getBackendSrv().datasourceRequest({
      url: '/api/tsdb/query',
      method: 'POST',
      data: {
        from: options.range.from.valueOf().toString(),
        to: options.range.to.valueOf().toString(),
        queries,
      },
    });

    const result: DataQueryResponseData[] = [];
    if (data.results) {
      Object.values(data.results).forEach((queryRes: any) => {
        queryRes.series?.forEach((series: any) => {
          const timeSeries: TimeSeries = {
            target: series.name,
            datapoints: series.points,
            refId: queryRes.refId,
            meta: queryRes.meta,
          };
          result.push(toDataFrame(timeSeries));
        });

        queryRes.tables?.forEach((table: any) => {
          result.push(toDataFrame(table));
        });
      });
    }

    return result;
  }

  metricFindQuery(query: string) {
    const workspacesQuery = query.match(/^workspaces\(\)/i);
    if (workspacesQuery) {
      return this.getWorkspaces(this.subscriptionId);
    }

    const workspacesQueryWithSub = query.match(/^workspaces\(["']?([^\)]+?)["']?\)/i);
    if (workspacesQueryWithSub) {
      return this.getWorkspaces((workspacesQueryWithSub[1] || '').trim());
    }

    return this.getDefaultOrFirstWorkspace().then((workspace: any) => {
      const queries: any[] = this.buildQuery(query, null, workspace);

      const promises = this.doQueries(queries);

      return Promise.all(promises)
        .then(results => {
          return new ResponseParser(results).parseToVariables();
        })
        .catch(err => {
          if (
            err.error &&
            err.error.data &&
            err.error.data.error &&
            err.error.data.error.innererror &&
            err.error.data.error.innererror.innererror
          ) {
            throw { message: err.error.data.error.innererror.innererror.message };
          } else if (err.error && err.error.data && err.error.data.error) {
            throw { message: err.error.data.error.message };
          }
        });
    });
  }

  private buildQuery(query: string, options: any, workspace: any) {
    const querystringBuilder = new LogAnalyticsQuerystringBuilder(
      this.templateSrv.replace(query, {}, this.interpolateVariable),
      options,
      'TimeGenerated'
    );
    const querystring = querystringBuilder.generate().uriString;
    const url = `${this.baseUrl}/${workspace}/query?${querystring}`;
    const queries: any[] = [];
    queries.push({
      datasourceId: this.id,
      url: url,
      resultFormat: 'table',
    });
    return queries;
  }

  interpolateVariable(value: string, variable: { multi: any; includeAll: any }) {
    if (typeof value === 'string') {
      if (variable.multi || variable.includeAll) {
        return "'" + value + "'";
      } else {
        return value;
      }
    }

    if (typeof value === 'number') {
      return value;
    }

    const quotedValues = _.map(value, val => {
      if (typeof value === 'number') {
        return value;
      }

      return "'" + val + "'";
    });
    return quotedValues.join(',');
  }

  getDefaultOrFirstWorkspace() {
    if (this.defaultOrFirstWorkspace) {
      return Promise.resolve(this.defaultOrFirstWorkspace);
    }

    return this.getWorkspaces(this.subscriptionId).then((workspaces: any[]) => {
      this.defaultOrFirstWorkspace = workspaces[0].value;
      return this.defaultOrFirstWorkspace;
    });
  }

  annotationQuery(options: any) {
    if (!options.annotation.rawQuery) {
      return Promise.reject({
        message: 'Query missing in annotation definition',
      });
    }

    const queries: any[] = this.buildQuery(options.annotation.rawQuery, options, options.annotation.workspace);

    const promises = this.doQueries(queries);

    return Promise.all(promises).then(results => {
      const annotations = new ResponseParser(results).transformToAnnotations(options);
      return annotations;
    });
  }

  doQueries(queries: any[]) {
    return _.map(queries, query => {
      return this.doRequest(query.url)
        .then((result: any) => {
          return {
            result: result,
            query: query,
          };
        })
        .catch((err: any) => {
          throw {
            error: err,
            query: query,
          };
        });
    });
  }

  doRequest(url: string, maxRetries = 1): Promise<any> {
    return getBackendSrv()
      .datasourceRequest({
        url: this.url + url,
        method: 'GET',
      })
      .catch((error: any) => {
        if (maxRetries > 0) {
          return this.doRequest(url, maxRetries - 1);
        }

        throw error;
      });
  }

  testDatasource() {
    const validationError = this.isValidConfig();
    if (validationError) {
      return validationError;
    }

    return this.getDefaultOrFirstWorkspace()
      .then((ws: any) => {
        const url = `${this.baseUrl}/${ws}/metadata`;

        return this.doRequest(url);
      })
      .then((response: any) => {
        if (response.status === 200) {
          return {
            status: 'success',
            message: 'Successfully queried the Azure Log Analytics service.',
            title: 'Success',
          };
        }

        return {
          status: 'error',
          message: 'Returned http status code ' + response.status,
        };
      })
      .catch((error: any) => {
        let message = 'Azure Log Analytics: ';
        if (error.config && error.config.url && error.config.url.indexOf('workspacesloganalytics') > -1) {
          message = 'Azure Log Analytics requires access to Azure Monitor but had the following error: ';
        }

        message = this.getErrorMessage(message, error);

        return {
          status: 'error',
          message: message,
        };
      });
  }

  private getErrorMessage(message: string, error: any) {
    message += error.statusText ? error.statusText + ': ' : '';
    if (error.data && error.data.error && error.data.error.code) {
      message += error.data.error.code + '. ' + error.data.error.message;
    } else if (error.data && error.data.error) {
      message += error.data.error;
    } else if (error.data) {
      message += error.data;
    } else {
      message += 'Cannot connect to Azure Log Analytics REST API.';
    }
    return message;
  }

  isValidConfig() {
    if (this.instanceSettings.jsonData.azureLogAnalyticsSameAs) {
      return undefined;
    }

    if (!this.isValidConfigField(this.instanceSettings.jsonData.logAnalyticsSubscriptionId)) {
      return {
        status: 'error',
        message: 'The Subscription Id field is required.',
      };
    }

    if (!this.isValidConfigField(this.instanceSettings.jsonData.logAnalyticsTenantId)) {
      return {
        status: 'error',
        message: 'The Tenant Id field is required.',
      };
    }

    if (!this.isValidConfigField(this.instanceSettings.jsonData.logAnalyticsClientId)) {
      return {
        status: 'error',
        message: 'The Client Id field is required.',
      };
    }

    return undefined;
  }

  isValidConfigField(field: string) {
    return field && field.length > 0;
  }
}
