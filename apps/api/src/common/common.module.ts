import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditExportService, FileAuditSink, HttpAuditSink } from './audit-sink';

@Global()
@Module({
  providers: [AuditService, AuditExportService, FileAuditSink, HttpAuditSink],
  exports: [AuditService, AuditExportService],
})
export class CommonModule {}
