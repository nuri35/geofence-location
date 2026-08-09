import { Module } from '@nestjs/common';

import { MqPublisherService } from './mq-publisher.service';

@Module({
  providers: [MqPublisherService],
  exports: [MqPublisherService],
})
export class MqModule {}
