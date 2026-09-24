from django.contrib import admin

from .models import AcceptanceRecord, AcceptanceAnnotationSnapshot


class AcceptanceSnapshotInline(admin.TabularInline):
    model = AcceptanceAnnotationSnapshot
    extra = 0
    readonly_fields = ("created_date", "updated_date")


@admin.register(AcceptanceRecord)
class AcceptanceRecordAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "job",
        "frame",
        "reviewer",
        "action_type",
        "status",
        "created_date",
    )
    list_filter = ("action_type", "status", "created_date")
    search_fields = ("description",)
    readonly_fields = ("created_date", "updated_date")
    raw_id_fields = ("job", "reviewer")
    inlines = [AcceptanceSnapshotInline]


@admin.register(AcceptanceAnnotationSnapshot)
class AcceptanceAnnotationSnapshotAdmin(admin.ModelAdmin):
    list_display = ("id", "record", "snapshot_type", "created_date")
    list_filter = ("snapshot_type", "created_date")
    readonly_fields = ("created_date", "updated_date")
    raw_id_fields = ("record",)
