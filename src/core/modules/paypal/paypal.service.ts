import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../common/services/config.service';
import { HttpService } from '@nestjs/axios';
import { AxiosBasicCredentials, AxiosRequestHeaders } from 'axios';
import { SubscriptionPlan, SubscriptionPlanDocument } from './models/subscription-plan.model';
import { Invoice } from './models/invoice/invoice.model';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

/**
 * PayPalService service
 */
@Injectable()
export class PayPalService {
  url: string;
  token: string;
  plans: SubscriptionPlan[] = [];

  /**
   * Inject services
   */
  constructor(
    protected configService: ConfigService,
    private httpService: HttpService,
    @InjectModel('SubscriptionPlan') protected readonly subscriptionPlanModel: Model<SubscriptionPlanDocument>
  ) {
    this.url =
      this.configService.get('paypal.mode') === 'LIVE'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
    this.init();
  }

  /**
   * Init token
   */
  async init() {
    if (this.configService.get('paypal.clientId') && this.configService.get('paypal.secret')) {
      this.token = await this.getCredentials();
      await this.loadPlans();
    }
  }

  /**
   * Get billing plans from paypal api
   */
  async loadPlans() {
    this.plans = [];
    await this.subscriptionPlanModel.db.dropCollection('subscriptionplans');
    const params = {
      page_size: 12,
      page: 1,
      total_required: true,
    };

    return new Promise<boolean>((resolve, reject) => {
      this.get('/v1/billing/plans', { params }).then(
        async (response) => {
          if (response?.data?.plans) {
            for (const plan of response.data.plans) {
              // Get plan details
              const detail = await this.getPlanDetails(plan.id);

              // Save to session
              this.plans.push(detail);

              // Save to db
              const dbPlan = new this.subscriptionPlanModel(detail);
              await dbPlan.save();
            }
            resolve(true);
          } else {
            resolve(false);
          }
        },
        (err) => {
          reject(err);
        }
      );
    });
  }

  /**
   * Get plan details by id
   *
   * @param id
   */
  getPlanDetails(id: string): Promise<SubscriptionPlan> {
    return new Promise<any>((resolve, reject) => {
      this.get('/v1/billing/plans/' + id).then(
        (response) => {
          resolve(response.data);
        },
        (err) => {
          reject(err);
        }
      );
    });
  }

  /**
   * Cancel subscription by id
   *
   * @param id
   */
  cancelSubscription(id: string): Promise<any> {
    const body = {
      reason: 'Not satisfied with the service',
    };

    return this.post('/v1/billing/subscriptions/' + id + '/cancel', body);
  }

  /**
   * Get invoices by user email
   *
   * @param email
   */
  getInvoicesByMail(email: string): Promise<Invoice[]> {
    const body = {
      recipient_email: email,
    };

    return this.post('/v2/invoicing/search-invoices', body);
  }

  /**
   * Get function with right headers
   *
   * @param path
   * @param options
   * @private
   */
  private get(path: string, options?: { params?: any; retry?: boolean }): Promise<any> {
    const retry = options?.retry ? options.retry : true;
    const headers: AxiosRequestHeaders = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

    return new Promise<any>((resolve, reject) => {
      this.httpService.get(this.url + path, { params: options?.params ? options.params : null, headers }).subscribe({
        next: (result) => {
          resolve(result);
        },
        error: async (err) => {
          if (retry) {
            // Get new token
            this.token = await this.getCredentials();

            // Try again
            return this.get(path, { ...options, retry: false });
          }
          reject(err);
        },
      });
    });
  }

  /**
   * Post function with right headers
   *
   * @param path
   * @param body
   * @param options
   * @private
   */
  private post(path: string, body: any, options?: { params?: any; retry?: boolean }): Promise<any> {
    const retry = options?.retry ? options.retry : true;
    const headers: AxiosRequestHeaders = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

    return new Promise<any>((resolve, reject) => {
      this.httpService
        .post(this.url + path, body, { params: options?.params ? options.params : null, headers })
        .subscribe({
          next: (result) => {
            resolve(result);
          },
          error: async (err) => {
            if (retry) {
              // Get new token
              this.token = await this.getCredentials();

              // Try again
              return this.get(path, { ...options, retry: false });
            }
            reject(err);
          },
        });
    });
  }

  /**
   * Get auth token for paypal communication
   *
   * @private
   */
  private getCredentials(): Promise<string> {
    return new Promise<any>((resolve, reject) => {
      const headers: AxiosRequestHeaders = {
        Accept: 'application/json',
        'Accept-Language': 'en_US',
        'Content-Type': 'application/x-www-form-urlencoded',
      };

      const auth: AxiosBasicCredentials = {
        username: this.configService.get('paypal.clientId'),
        password: this.configService.get('paypal.secret'),
      };

      this.httpService
        .post(this.url + '/v1/oauth2/token', 'grant_type=client_credentials', { headers, auth })
        .subscribe({
          next: (response) => {
            if (response.data) {
              resolve(response.data.access_token);
            }
          },
          error: (err) => {
            reject(err);
          },
        });
    });
  }
}
