# Copyright (C) 2021-2022 Intel Corporation
# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

from django.contrib import admin
from django.contrib.auth.admin import GroupAdmin, UserAdmin
from django.contrib.auth.models import Group, User
from django.utils.translation import gettext_lazy as _

from cvat.apps.engine.models import Profile

# Only this Django username may toggle Profile.has_acceptance_access.
# IAM admin / is_superuser alone is not enough (service accounts stay ops admins).
ACCEPTANCE_ACCESS_MANAGER_USERNAME = "admin"


def can_manage_acceptance_access(user) -> bool:
    return bool(
        user
        and getattr(user, "is_authenticated", False)
        and user.username == ACCEPTANCE_ACCESS_MANAGER_USERNAME
    )


class ProfileInline(admin.StackedInline):
    model = Profile
    fieldsets = ((None, {"fields": ("has_analytics_access", "has_acceptance_access")}),)

    def get_readonly_fields(self, request, obj=None):
        readonly = list(super().get_readonly_fields(request, obj) or [])
        if not can_manage_acceptance_access(request.user):
            if "has_acceptance_access" not in readonly:
                readonly.append("has_acceptance_access")
        return readonly


class CustomUserAdmin(UserAdmin):
    inlines = (ProfileInline,)
    list_display = ("username", "email", "first_name", "last_name", "is_active", "is_staff")
    fieldsets = (
        (None, {"fields": ("username", "password")}),
        (_("Personal info"), {"fields": ("first_name", "last_name", "email")}),
        (
            _("Permissions"),
            {
                "fields": (
                    "is_active",
                    "is_staff",
                    "is_superuser",
                    "groups",
                )
            },
        ),
        (_("Important dates"), {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = (
        (
            None,
            {
                "classes": ("wide",),
                "fields": ("username", "email", "password1", "password2"),
            },
        ),
    )
    actions = ["user_activate", "user_deactivate"]

    def save_formset(self, request, form, formset, change):
        """Ignore POST tampering of has_acceptance_access by non-managers."""
        if formset.model is Profile and not can_manage_acceptance_access(request.user):
            instances = formset.save(commit=False)
            for obj in instances:
                if obj.pk:
                    previous = Profile.objects.filter(pk=obj.pk).values_list(
                        "has_acceptance_access", flat=True
                    ).first()
                    obj.has_acceptance_access = bool(previous)
                else:
                    obj.has_acceptance_access = False
                obj.save()
            for obj in formset.deleted_objects:
                obj.delete()
            formset.save_m2m()
            return
        super().save_formset(request, form, formset, change)

    @admin.action(permissions=["change"], description=_("Mark selected users as active"))
    def user_activate(self, request, queryset):
        queryset.update(is_active=True)

    @admin.action(permissions=["change"], description=_("Mark selected users as not active"))
    def user_deactivate(self, request, queryset):
        queryset.update(is_active=False)


class CustomGroupAdmin(GroupAdmin):
    fieldsets = ((None, {"fields": ("name",)}),)


admin.site.unregister(User)
admin.site.unregister(Group)
admin.site.register(User, CustomUserAdmin)
admin.site.register(Group, CustomGroupAdmin)
