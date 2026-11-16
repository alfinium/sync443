# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""Strict WBXML 1.3 codec for the Exchange ActiveSync test server.

Written from [MS-ASWBXML] (code pages, section 2.1.2.1) and WAP-192 (WBXML
1.3). Python standard library only. The code page tables are the data of
src/core/codepages.mjs, ported to Python (test_mock_eas.py checks that both
stay identical).

The decoder plays a strict server: it refuses anything an ActiveSync
client never has to send, so that a sloppy request fails the test instead
of being silently accepted:
  - a header other than version 1.3 (0x03), public id 1 (unknown), charset
    106 (UTF-8) and an empty string table;
  - attributes, entities, string table references, LITERAL tags, extension
    tokens and processing instructions;
  - an unknown code page or an unknown tag in a known page;
  - text that is not valid UTF-8 (opaque data is not checked);
  - text mixed with child elements, or inline text mixed with opaque data;
  - a truncated document, an END without an open element, several root
    elements, anything after the root element;
  - documents above the size, element-count or depth limits.

Tree: Element(ns, tag, children, value, opaque). `value` is bytes or None
(None: no text at all); `opaque` tells OPAQUE data from inline strings.

    doc = el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", "0")])])])
    data = encode(doc)
    assert decode(data) == doc
"""

__all__ = [
    "WbxmlError", "Element", "el", "encode", "decode", "to_xml",
    "PAGES", "page_of", "namespace_of", "token_of", "tag_of",
]

# Global tokens (WAP-192 section 7.1).
SWITCH_PAGE = 0x00
END = 0x01
ENTITY = 0x02
STR_I = 0x03
LITERAL = 0x04
PI = 0x43
STR_T = 0x83
OPAQUE = 0xC3
_REFUSED_GLOBALS = {
    ENTITY: "ENTITY", LITERAL: "LITERAL", 0x40: "EXT_I_0", 0x41: "EXT_I_1", 0x42: "EXT_I_2", PI: "PI",
    0x44: "LITERAL_C", 0x80: "EXT_T_0", 0x81: "EXT_T_1", 0x82: "EXT_T_2", STR_T: "STR_T", 0x84: "LITERAL_A",
    0xC0: "EXT_0", 0xC1: "EXT_1", 0xC2: "EXT_2", 0xC4: "LITERAL_AC",
}
VERSION_1_3 = 0x03
PUBLIC_ID_UNKNOWN = 0x01
CHARSET_UTF8 = 106

MAX_BYTES = 64 * 1024 * 1024
MAX_NODES = 500_000
MAX_DEPTH = 64

# Code pages of [MS-ASWBXML] 2.1.2.1: (page, namespace, ((token, tag), ...)).
# Pages 3 (AirNotify) and 25 (Find) are left out, as in codepages.mjs.
PAGES = (
    (0, "AirSync", (
        (0x05, "Sync"), (0x06, "Responses"), (0x07, "Add"), (0x08, "Change"), (0x09, "Delete"),
        (0x0a, "Fetch"), (0x0b, "SyncKey"), (0x0c, "ClientId"), (0x0d, "ServerId"), (0x0e, "Status"),
        (0x0f, "Collection"), (0x10, "Class"), (0x12, "CollectionId"), (0x13, "GetChanges"),
        (0x14, "MoreAvailable"), (0x15, "WindowSize"), (0x16, "Commands"), (0x17, "Options"),
        (0x18, "FilterType"), (0x1b, "Conflict"), (0x1c, "Collections"), (0x1d, "ApplicationData"),
        (0x1e, "DeletesAsMoves"), (0x20, "Supported"), (0x21, "SoftDelete"), (0x22, "MIMESupport"),
        (0x23, "MIMETruncation"), (0x24, "Wait"), (0x25, "Limit"), (0x26, "Partial"),
        (0x27, "ConversationMode"), (0x28, "MaxItems"), (0x29, "HeartbeatInterval"),
    )),
    (1, "Contacts", (
        (0x05, "Anniversary"), (0x06, "AssistantName"), (0x07, "AssistantPhoneNumber"), (0x08, "Birthday"),
        (0x0c, "Business2PhoneNumber"), (0x0d, "BusinessAddressCity"), (0x0e, "BusinessAddressCountry"),
        (0x0f, "BusinessAddressPostalCode"), (0x10, "BusinessAddressState"), (0x11, "BusinessAddressStreet"),
        (0x12, "BusinessFaxNumber"), (0x13, "BusinessPhoneNumber"), (0x14, "CarPhoneNumber"),
        (0x15, "Categories"), (0x16, "Category"), (0x17, "Children"), (0x18, "Child"), (0x19, "CompanyName"),
        (0x1a, "Department"), (0x1b, "Email1Address"), (0x1c, "Email2Address"), (0x1d, "Email3Address"),
        (0x1e, "FileAs"), (0x1f, "FirstName"), (0x20, "Home2PhoneNumber"), (0x21, "HomeAddressCity"),
        (0x22, "HomeAddressCountry"), (0x23, "HomeAddressPostalCode"), (0x24, "HomeAddressState"),
        (0x25, "HomeAddressStreet"), (0x26, "HomeFaxNumber"), (0x27, "HomePhoneNumber"), (0x28, "JobTitle"),
        (0x29, "LastName"), (0x2a, "MiddleName"), (0x2b, "MobilePhoneNumber"), (0x2c, "OfficeLocation"),
        (0x2d, "OtherAddressCity"), (0x2e, "OtherAddressCountry"), (0x2f, "OtherAddressPostalCode"),
        (0x30, "OtherAddressState"), (0x31, "OtherAddressStreet"), (0x32, "PagerNumber"),
        (0x33, "RadioPhoneNumber"), (0x34, "Spouse"), (0x35, "Suffix"), (0x36, "Title"), (0x37, "WebPage"),
        (0x38, "YomiCompanyName"), (0x39, "YomiFirstName"), (0x3a, "YomiLastName"), (0x3c, "Picture"),
        (0x3d, "Alias"), (0x3e, "WeightedRank"),
    )),
    (2, "Email", (
        (0x0f, "DateReceived"), (0x11, "DisplayTo"), (0x12, "Importance"), (0x13, "MessageClass"),
        (0x14, "Subject"), (0x15, "Read"), (0x16, "To"), (0x17, "Cc"), (0x18, "From"), (0x19, "ReplyTo"),
        (0x1a, "AllDayEvent"), (0x1b, "Categories"), (0x1c, "Category"), (0x1d, "DtStamp"), (0x1e, "EndTime"),
        (0x1f, "InstanceType"), (0x20, "BusyStatus"), (0x21, "Location"), (0x22, "MeetingRequest"),
        (0x23, "Organizer"), (0x24, "RecurrenceId"), (0x25, "Reminder"), (0x26, "ResponseRequested"),
        (0x27, "Recurrences"), (0x28, "Recurrence"), (0x29, "Type"), (0x2a, "Until"), (0x2b, "Occurrences"),
        (0x2c, "Interval"), (0x2d, "DayOfWeek"), (0x2e, "DayOfMonth"), (0x2f, "WeekOfMonth"),
        (0x30, "MonthOfYear"), (0x31, "StartTime"), (0x32, "Sensitivity"), (0x33, "TimeZone"),
        (0x34, "GlobalObjId"), (0x35, "ThreadTopic"), (0x39, "InternetCPID"), (0x3a, "Flag"), (0x3b, "Status"),
        (0x3c, "ContentClass"), (0x3d, "FlagType"), (0x3e, "CompleteTime"), (0x3f, "DisallowNewTimeProposal"),
    )),
    (4, "Calendar", (
        (0x05, "Timezone"), (0x06, "AllDayEvent"), (0x07, "Attendees"), (0x08, "Attendee"), (0x09, "Email"),
        (0x0a, "Name"), (0x0d, "BusyStatus"), (0x0e, "Categories"), (0x0f, "Category"), (0x11, "DtStamp"),
        (0x12, "EndTime"), (0x13, "Exception"), (0x14, "Exceptions"), (0x15, "Deleted"),
        (0x16, "ExceptionStartTime"), (0x17, "Location"), (0x18, "MeetingStatus"), (0x19, "OrganizerEmail"),
        (0x1a, "OrganizerName"), (0x1b, "Recurrence"), (0x1c, "Type"), (0x1d, "Until"), (0x1e, "Occurrences"),
        (0x1f, "Interval"), (0x20, "DayOfWeek"), (0x21, "DayOfMonth"), (0x22, "WeekOfMonth"),
        (0x23, "MonthOfYear"), (0x24, "Reminder"), (0x25, "Sensitivity"), (0x26, "Subject"),
        (0x27, "StartTime"), (0x28, "UID"), (0x29, "AttendeeStatus"), (0x2a, "AttendeeType"),
        (0x33, "DisallowNewTimeProposal"), (0x34, "ResponseRequested"), (0x35, "AppointmentReplyTime"),
        (0x36, "ResponseType"), (0x37, "CalendarType"), (0x38, "IsLeapMonth"), (0x39, "FirstDayOfWeek"),
        (0x3a, "OnlineMeetingConfLink"), (0x3b, "OnlineMeetingExternalLink"), (0x3c, "ClientUid"),
    )),
    (5, "Move", (
        (0x05, "MoveItems"), (0x06, "Move"), (0x07, "SrcMsgId"), (0x08, "SrcFldId"), (0x09, "DstFldId"),
        (0x0a, "Response"), (0x0b, "Status"), (0x0c, "DstMsgId"),
    )),
    (6, "GetItemEstimate", (
        (0x05, "GetItemEstimate"), (0x07, "Collections"), (0x08, "Collection"), (0x0a, "CollectionId"),
        (0x0c, "Estimate"), (0x0d, "Response"), (0x0e, "Status"),
    )),
    (7, "FolderHierarchy", (
        (0x07, "DisplayName"), (0x08, "ServerId"), (0x09, "ParentId"), (0x0a, "Type"), (0x0c, "Status"),
        (0x0e, "Changes"), (0x0f, "Add"), (0x10, "Delete"), (0x11, "Update"), (0x12, "SyncKey"),
        (0x13, "FolderCreate"), (0x14, "FolderDelete"), (0x15, "FolderUpdate"), (0x16, "FolderSync"),
        (0x17, "Count"),
    )),
    (8, "MeetingResponse", (
        (0x05, "CalendarId"), (0x06, "CollectionId"), (0x07, "MeetingResponse"), (0x08, "RequestId"),
        (0x09, "Request"), (0x0a, "Result"), (0x0b, "Status"), (0x0c, "UserResponse"), (0x0e, "InstanceId"),
        (0x10, "ProposedStartTime"), (0x11, "ProposedEndTime"), (0x12, "SendResponse"),
    )),
    (9, "Tasks", (
        (0x08, "Categories"), (0x09, "Category"), (0x0a, "Complete"), (0x0b, "DateCompleted"),
        (0x0c, "DueDate"), (0x0d, "UtcDueDate"), (0x0e, "Importance"), (0x0f, "Recurrence"), (0x10, "Type"),
        (0x11, "Start"), (0x12, "Until"), (0x13, "Occurrences"), (0x14, "Interval"), (0x15, "DayOfMonth"),
        (0x16, "DayOfWeek"), (0x17, "WeekOfMonth"), (0x18, "MonthOfYear"), (0x19, "Regenerate"),
        (0x1a, "DeadOccur"), (0x1b, "ReminderSet"), (0x1c, "ReminderTime"), (0x1d, "Sensitivity"),
        (0x1e, "StartDate"), (0x1f, "UtcStartDate"), (0x20, "Subject"), (0x22, "OrdinalDate"),
        (0x23, "SubOrdinalDate"), (0x24, "CalendarType"), (0x25, "IsLeapMonth"), (0x26, "FirstDayOfWeek"),
    )),
    (10, "ResolveRecipients", (
        (0x05, "ResolveRecipients"), (0x06, "Response"), (0x07, "Status"), (0x08, "Type"), (0x09, "Recipient"),
        (0x0a, "DisplayName"), (0x0b, "EmailAddress"), (0x0c, "Certificates"), (0x0d, "Certificate"),
        (0x0e, "MiniCertificate"), (0x0f, "Options"), (0x10, "To"), (0x11, "CertificateRetrieval"),
        (0x12, "RecipientCount"), (0x13, "MaxCertificates"), (0x14, "MaxAmbiguousRecipients"),
        (0x15, "CertificateCount"), (0x16, "Availability"), (0x17, "StartTime"), (0x18, "EndTime"),
        (0x19, "MergedFreeBusy"), (0x1a, "Picture"), (0x1b, "MaxSize"), (0x1c, "Data"), (0x1d, "MaxPictures"),
    )),
    (11, "ValidateCert", (
        (0x05, "ValidateCert"), (0x06, "Certificates"), (0x07, "Certificate"), (0x08, "CertificateChain"),
        (0x09, "CheckCRL"), (0x0a, "Status"),
    )),
    (12, "Contacts2", (
        (0x05, "CustomerId"), (0x06, "GovernmentId"), (0x07, "IMAddress"), (0x08, "IMAddress2"),
        (0x09, "IMAddress3"), (0x0a, "ManagerName"), (0x0b, "CompanyMainPhone"), (0x0c, "AccountName"),
        (0x0d, "NickName"), (0x0e, "MMS"),
    )),
    (13, "Ping", (
        (0x05, "Ping"), (0x06, "AutdState"), (0x07, "Status"), (0x08, "HeartbeatInterval"), (0x09, "Folders"),
        (0x0a, "Folder"), (0x0b, "Id"), (0x0c, "Class"), (0x0d, "MaxFolders"),
    )),
    (14, "Provision", (
        (0x05, "Provision"), (0x06, "Policies"), (0x07, "Policy"), (0x08, "PolicyType"), (0x09, "PolicyKey"),
        (0x0a, "Data"), (0x0b, "Status"), (0x0c, "RemoteWipe"), (0x0d, "EASProvisionDoc"),
        (0x0e, "DevicePasswordEnabled"), (0x0f, "AlphanumericDevicePasswordRequired"),
        (0x10, "RequireStorageCardEncryption"), (0x11, "PasswordRecoveryEnabled"),
        (0x13, "AttachmentsEnabled"), (0x14, "MinDevicePasswordLength"), (0x15, "MaxInactivityTimeDeviceLock"),
        (0x16, "MaxDevicePasswordFailedAttempts"), (0x17, "MaxAttachmentSize"),
        (0x18, "AllowSimpleDevicePassword"), (0x19, "DevicePasswordExpiration"),
        (0x1a, "DevicePasswordHistory"), (0x1b, "AllowStorageCard"), (0x1c, "AllowCamera"),
        (0x1d, "RequireDeviceEncryption"), (0x1e, "AllowUnsignedApplications"),
        (0x1f, "AllowUnsignedInstallationPackages"), (0x20, "MinDevicePasswordComplexCharacters"),
        (0x21, "AllowWiFi"), (0x22, "AllowTextMessaging"), (0x23, "AllowPOPIMAPEmail"),
        (0x24, "AllowBluetooth"), (0x25, "AllowIrDA"), (0x26, "RequireManualSyncWhenRoaming"),
        (0x27, "AllowDesktopSync"), (0x28, "MaxCalendarAgeFilter"), (0x29, "AllowHTMLEmail"),
        (0x2a, "MaxEmailAgeFilter"), (0x2b, "MaxEmailBodyTruncationSize"),
        (0x2c, "MaxEmailHTMLBodyTruncationSize"), (0x2d, "RequireSignedSMIMEMessages"),
        (0x2e, "RequireEncryptedSMIMEMessages"), (0x2f, "RequireSignedSMIMEAlgorithm"),
        (0x30, "RequireEncryptionSMIMEAlgorithm"), (0x31, "AllowSMIMEEncryptionAlgorithmNegotiation"),
        (0x32, "AllowSMIMESoftCerts"), (0x33, "AllowBrowser"), (0x34, "AllowConsumerEmail"),
        (0x35, "AllowRemoteDesktop"), (0x36, "AllowInternetSharing"), (0x37, "UnapprovedInROMApplicationList"),
        (0x38, "ApplicationName"), (0x39, "ApprovedApplicationList"), (0x3a, "Hash"),
        (0x3b, "AccountOnlyRemoteWipe"),
    )),
    (15, "Search", (
        (0x05, "Search"), (0x07, "Store"), (0x08, "Name"), (0x09, "Query"), (0x0a, "Options"), (0x0b, "Range"),
        (0x0c, "Status"), (0x0d, "Response"), (0x0e, "Result"), (0x0f, "Properties"), (0x10, "Total"),
        (0x11, "EqualTo"), (0x12, "Value"), (0x13, "And"), (0x14, "Or"), (0x15, "FreeText"),
        (0x17, "DeepTraversal"), (0x18, "LongId"), (0x19, "RebuildResults"), (0x1a, "LessThan"),
        (0x1b, "GreaterThan"), (0x1e, "UserName"), (0x1f, "Password"), (0x20, "ConversationId"),
        (0x21, "Picture"), (0x22, "MaxSize"), (0x23, "MaxPictures"),
    )),
    (16, "GAL", (
        (0x05, "DisplayName"), (0x06, "Phone"), (0x07, "Office"), (0x08, "Title"), (0x09, "Company"),
        (0x0a, "Alias"), (0x0b, "FirstName"), (0x0c, "LastName"), (0x0d, "HomePhone"), (0x0e, "MobilePhone"),
        (0x0f, "EmailAddress"), (0x10, "Picture"), (0x11, "Status"), (0x12, "Data"),
    )),
    (17, "AirSyncBase", (
        (0x05, "BodyPreference"), (0x06, "Type"), (0x07, "TruncationSize"), (0x08, "AllOrNone"),
        (0x0a, "Body"), (0x0b, "Data"), (0x0c, "EstimatedDataSize"), (0x0d, "Truncated"),
        (0x0e, "Attachments"), (0x0f, "Attachment"), (0x10, "DisplayName"), (0x11, "FileReference"),
        (0x12, "Method"), (0x13, "ContentId"), (0x14, "ContentLocation"), (0x15, "IsInline"),
        (0x16, "NativeBodyType"), (0x17, "ContentType"), (0x18, "Preview"), (0x19, "BodyPartPreference"),
        (0x1a, "BodyPart"), (0x1b, "Status"), (0x1c, "Add"), (0x1d, "Delete"), (0x1e, "ClientId"),
        (0x1f, "Content"), (0x20, "Location"), (0x21, "Annotation"), (0x22, "Street"), (0x23, "City"),
        (0x24, "State"), (0x25, "Country"), (0x26, "PostalCode"), (0x27, "Latitude"), (0x28, "Longitude"),
        (0x29, "Accuracy"), (0x2a, "Altitude"), (0x2b, "AltitudeAccuracy"), (0x2c, "LocationUri"),
        (0x2d, "InstanceId"),
    )),
    (18, "Settings", (
        (0x05, "Settings"), (0x06, "Status"), (0x07, "Get"), (0x08, "Set"), (0x09, "Oof"), (0x0a, "OofState"),
        (0x0b, "StartTime"), (0x0c, "EndTime"), (0x0d, "OofMessage"), (0x0e, "AppliesToInternal"),
        (0x0f, "AppliesToExternalKnown"), (0x10, "AppliesToExternalUnknown"), (0x11, "Enabled"),
        (0x12, "ReplyMessage"), (0x13, "BodyType"), (0x14, "DevicePassword"), (0x15, "Password"),
        (0x16, "DeviceInformation"), (0x17, "Model"), (0x18, "IMEI"), (0x19, "FriendlyName"), (0x1a, "OS"),
        (0x1b, "OSLanguage"), (0x1c, "PhoneNumber"), (0x1d, "UserInformation"), (0x1e, "EmailAddresses"),
        (0x1f, "SMTPAddress"), (0x20, "UserAgent"), (0x21, "EnableOutboundSMS"), (0x22, "MobileOperator"),
        (0x23, "PrimarySmtpAddress"), (0x24, "Accounts"), (0x25, "Account"), (0x26, "AccountId"),
        (0x27, "AccountName"), (0x28, "UserDisplayName"), (0x29, "SendDisabled"),
        (0x2b, "RightsManagementInformation"),
    )),
    (19, "DocumentLibrary", (
        (0x05, "LinkId"), (0x06, "DisplayName"), (0x07, "IsFolder"), (0x08, "CreationDate"),
        (0x09, "LastModifiedDate"), (0x0a, "IsHidden"), (0x0b, "ContentLength"), (0x0c, "ContentType"),
    )),
    (20, "ItemOperations", (
        (0x05, "ItemOperations"), (0x06, "Fetch"), (0x07, "Store"), (0x08, "Options"), (0x09, "Range"),
        (0x0a, "Total"), (0x0b, "Properties"), (0x0c, "Data"), (0x0d, "Status"), (0x0e, "Response"),
        (0x0f, "Version"), (0x10, "Schema"), (0x11, "Part"), (0x12, "EmptyFolderContents"),
        (0x13, "DeleteSubFolders"), (0x14, "UserName"), (0x15, "Password"), (0x16, "Move"), (0x17, "DstFldId"),
        (0x18, "ConversationId"), (0x19, "MoveAlways"),
    )),
    (21, "ComposeMail", (
        (0x05, "SendMail"), (0x06, "SmartForward"), (0x07, "SmartReply"), (0x08, "SaveInSentItems"),
        (0x09, "ReplaceMime"), (0x0b, "Source"), (0x0c, "FolderId"), (0x0d, "ItemId"), (0x0e, "LongId"),
        (0x0f, "InstanceId"), (0x10, "Mime"), (0x11, "ClientId"), (0x12, "Status"), (0x13, "AccountId"),
        (0x15, "Forwardees"), (0x16, "Forwardee"), (0x17, "ForwardeeName"), (0x18, "ForwardeeEmail"),
    )),
    (22, "Email2", (
        (0x05, "UmCallerID"), (0x06, "UmUserNotes"), (0x07, "UmAttDuration"), (0x08, "UmAttOrder"),
        (0x09, "ConversationId"), (0x0a, "ConversationIndex"), (0x0b, "LastVerbExecuted"),
        (0x0c, "LastVerbExecutionTime"), (0x0d, "ReceivedAsBcc"), (0x0e, "Sender"), (0x0f, "CalendarType"),
        (0x10, "IsLeapMonth"), (0x11, "AccountId"), (0x12, "FirstDayOfWeek"), (0x13, "MeetingMessageType"),
        (0x15, "IsDraft"), (0x16, "Bcc"), (0x17, "Send"),
    )),
    (23, "Notes", (
        (0x05, "Subject"), (0x06, "MessageClass"), (0x07, "LastModifiedDate"), (0x08, "Categories"),
        (0x09, "Category"),
    )),
    (24, "RightsManagement", (
        (0x05, "RightsManagementSupport"), (0x06, "RightsManagementTemplates"),
        (0x07, "RightsManagementTemplate"), (0x08, "RightsManagementLicense"), (0x09, "EditAllowed"),
        (0x0a, "ReplyAllowed"), (0x0b, "ReplyAllAllowed"), (0x0c, "ForwardAllowed"),
        (0x0d, "ModifyRecipientsAllowed"), (0x0e, "ExtractAllowed"), (0x0f, "PrintAllowed"),
        (0x10, "ExportAllowed"), (0x11, "ProgrammaticAccessAllowed"), (0x12, "Owner"),
        (0x13, "ContentExpiryDate"), (0x14, "TemplateID"), (0x15, "TemplateName"),
        (0x16, "TemplateDescription"), (0x17, "ContentOwner"), (0x18, "RemoveRightsManagementProtection"),
    )),
)

_NS_OF_PAGE = {}
_PAGE_OF_NS = {}
_TAG_OF = {}
_TOKEN_OF = {}


def _build_tables():
    for page, ns, tags in PAGES:
        if page in _NS_OF_PAGE or ns in _PAGE_OF_NS:
            raise AssertionError(f"wbxml: page en double {page} {ns}")
        _NS_OF_PAGE[page] = ns
        _PAGE_OF_NS[ns] = page
        seen = set()
        for token, tag in tags:
            if not 0x05 <= token <= 0x3F:
                raise AssertionError(f"wbxml: jeton hors limites {ns}:{tag}")
            if (page, token) in _TAG_OF or tag in seen:
                raise AssertionError(f"wbxml: balise en double {ns}:{tag}")
            seen.add(tag)
            _TAG_OF[(page, token)] = tag
            _TOKEN_OF[(ns, tag)] = token


_build_tables()


def page_of(ns):
    """Code page number of a namespace, or None."""
    return _PAGE_OF_NS.get(ns)


def namespace_of(page):
    """Namespace of a code page, or None."""
    return _NS_OF_PAGE.get(page)


def token_of(ns, tag):
    """Token of a tag in a namespace, or None."""
    return _TOKEN_OF.get((ns, tag))


def tag_of(page, token):
    """Tag of a token in a code page, or None."""
    return _TAG_OF.get((page, token))


class WbxmlError(ValueError):
    def __init__(self, message):
        super().__init__(f"WBXML : {message}")


# ── Tree ──────────────────────────────────────────────────────────────────


class Element:
    """One element. `ns` may be None in a tree being built: it is then the
    parent's namespace, filled in when the parent is built with el()."""

    __slots__ = ("ns", "tag", "children", "value", "opaque")

    def __init__(self, ns, tag, children=None, value=None, opaque=False):
        self.ns = ns
        self.tag = tag
        self.children = list(children) if children else []
        self.value = value
        self.opaque = bool(opaque)

    @property
    def name(self):
        return f"{self.ns}:{self.tag}"

    def _matches(self, name):
        ns, sep, tag = name.rpartition(":")
        return self.tag == tag and (not sep or self.ns == ns)

    def child(self, name):
        """First child named "Tag" or "Namespace:Tag", or None."""
        for c in self.children:
            if c._matches(name):
                return c
        return None

    def children_named(self, name):
        return [c for c in self.children if c._matches(name)]

    def find(self, *path):
        """Follow a path of child names; None if a step is missing."""
        node = self
        for name in path:
            node = node.child(name)
            if node is None:
                return None
        return node

    def has(self, *path):
        return self.find(*path) is not None

    def text(self, *path):
        """UTF-8 text of the element at `path`: None if absent, "" if empty.
        Raises WbxmlError if the bytes are not UTF-8 (opaque data included)."""
        node = self.find(*path)
        if node is None:
            return None
        if not node.value:
            return ""
        try:
            return node.value.decode("utf-8")
        except UnicodeDecodeError:
            raise WbxmlError(f"<{node.name}> : texte UTF-8 invalide") from None

    def data(self, *path):
        """Raw bytes of the element at `path`: None if absent, b"" if empty."""
        node = self.find(*path)
        if node is None:
            return None
        return node.value or b""

    def __eq__(self, other):
        if not isinstance(other, Element):
            return NotImplemented
        return (self.ns, self.tag, self.value or None, self.opaque, self.children) == (
            other.ns, other.tag, other.value or None, other.opaque, other.children)

    def __ne__(self, other):
        result = self.__eq__(other)
        return result if result is NotImplemented else not result

    __hash__ = None

    def __repr__(self):
        return f"<Element {self.name}>"

    def __str__(self):
        return to_xml(self)


def _resolve(node, ns):
    """Give `ns` to every descendant that has no namespace yet (iteratively)."""
    stack = [(node, ns)]
    while stack:
        n, inherited = stack.pop()
        if n.ns is None:
            n.ns = inherited
        for c in n.children:
            if c.ns is None:
                stack.append((c, n.ns))


def el(name, content=None, opaque=None):
    """Build an element.

    name     "Namespace:Tag", or "Tag" to take the parent's namespace.
    content  None (empty element); str or int (inline UTF-8 text); bytes
             (OPAQUE data, or an inline string with opaque=False); a list or
             tuple of elements (None and False entries are skipped).
    """
    ns, sep, tag = name.rpartition(":")
    node = Element(ns if sep else None, tag)
    if content is None:
        pass
    elif isinstance(content, (list, tuple)):
        node.children = [c for c in content if c is not None and c is not False]
        for c in node.children:
            if not isinstance(c, Element):
                raise WbxmlError(f"<{name}> : enfant invalide {type(c).__name__}")
    elif isinstance(content, (bytes, bytearray, memoryview)):
        node.value = bytes(content)
        node.opaque = True if opaque is None else bool(opaque)
    elif isinstance(content, bool):
        raise WbxmlError(f"<{name}> : booléen refusé (écrire \"0\" ou \"1\")")
    elif isinstance(content, (str, int)):
        node.value = str(content).encode("utf-8")
        node.opaque = bool(opaque)
    else:
        raise WbxmlError(f"<{name}> : contenu invalide {type(content).__name__}")
    if node.ns is not None:
        _resolve(node, node.ns)
    return node


# ── Writing ──────────────────────────────────────────────────────────────


def _mb_uint32(value):
    if not isinstance(value, int) or value < 0 or value > 0xFFFFFFFF:
        raise WbxmlError("entier hors limites")
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.append(0x80 | (value & 0x7F))
        value >>= 7
    return bytes(reversed(out))


def encode(root):
    """Element tree -> WBXML bytes. Refuses unknown tags, NUL in inline text,
    and text mixed with child elements."""
    if not isinstance(root, Element) or not root.ns:
        raise WbxmlError("l'élément racine doit avoir un espace de noms")
    out = bytearray((VERSION_1_3, PUBLIC_ID_UNKNOWN, CHARSET_UTF8, 0x00))
    page = 0
    # Iterative depth-first walk: (node, inherited namespace, depth), or None for an END.
    stack = [(root, root.ns, 1)]
    while stack:
        item = stack.pop()
        if item is None:
            out.append(END)
            continue
        node, inherited, depth = item
        if not isinstance(node, Element):
            raise WbxmlError(f"élément invalide {type(node).__name__}")
        ns = node.ns or inherited
        p = page_of(ns)
        if p is None:
            raise WbxmlError(f"espace de noms inconnu « {ns} »")
        token = token_of(ns, node.tag)
        if token is None:
            raise WbxmlError(f"balise inconnue « {ns}:{node.tag} »")
        if node.value is not None and node.children:
            raise WbxmlError(f"<{ns}:{node.tag}> : texte et éléments mêlés")
        if depth > MAX_DEPTH:
            raise WbxmlError("imbrication trop profonde")
        if p != page:
            out += bytes((SWITCH_PAGE, p))
            page = p
        has_content = node.value is not None or bool(node.children)
        out.append(token | 0x40 if has_content else token)
        if not has_content:
            continue
        if node.value is not None:
            value = bytes(node.value)
            if node.opaque:
                out.append(OPAQUE)
                out += _mb_uint32(len(value))
                out += value
            else:
                if b"\x00" in value:
                    raise WbxmlError(f"caractère NUL refusé dans <{ns}:{node.tag}>")
                out.append(STR_I)
                out += value
                out.append(0x00)
        stack.append(None)
        for c in reversed(node.children):
            stack.append((c, ns, depth + 1))
    return bytes(out)


# ── Reading ──────────────────────────────────────────────────────────────


def decode(data, *, max_bytes=MAX_BYTES, max_nodes=MAX_NODES, max_depth=MAX_DEPTH, check_utf8=True):
    """WBXML bytes -> Element (the root). Raises WbxmlError on anything malformed."""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise WbxmlError("données invalides")
    data = bytes(data)
    if len(data) > max_bytes:
        raise WbxmlError(f"document trop volumineux ({len(data)} octets)")
    n = len(data)
    pos = 0

    def mb_uint32():
        nonlocal pos
        value = 0
        for _ in range(5):
            if pos >= n:
                raise WbxmlError("document tronqué (entier)")
            b = data[pos]
            pos += 1
            value = (value << 7) | (b & 0x7F)
            if not b & 0x80:
                if value > 0xFFFFFFFF:
                    raise WbxmlError("entier hors limites")
                return value
        raise WbxmlError("entier trop long")

    if n < 4:
        raise WbxmlError("document tronqué (en-tête)")
    version = data[pos]
    pos += 1
    if version != VERSION_1_3:
        raise WbxmlError(f"version 0x{version:02x} refusée (1.3 attendue)")
    public_id = mb_uint32()
    if public_id != PUBLIC_ID_UNKNOWN:
        raise WbxmlError(f"identifiant public {public_id} refusé (1 attendu)")
    charset = mb_uint32()
    if charset != CHARSET_UTF8:
        raise WbxmlError(f"jeu de caractères {charset} refusé (106, UTF-8, attendu)")
    table = mb_uint32()
    if table != 0:
        raise WbxmlError("table des chaînes refusée (ActiveSync n'en utilise pas)")

    page = 0
    root = None
    stack = []  # open elements
    pieces = []  # per open element: list of text/opaque pieces
    kinds = []  # per open element: None, "text" or "opaque"
    nodes = 0

    def finish():
        node = stack.pop()
        parts = pieces.pop()
        kind = kinds.pop()
        if kind is not None:
            if node.children:
                raise WbxmlError(f"<{node.name}> : texte et éléments mêlés")
            node.value = b"".join(parts)
            node.opaque = kind == "opaque"
            if check_utf8 and not node.opaque:
                try:
                    node.value.decode("utf-8")
                except UnicodeDecodeError:
                    raise WbxmlError(f"<{node.name}> : texte UTF-8 invalide") from None

    while pos < n:
        b = data[pos]
        pos += 1
        if root is not None and not stack:
            raise WbxmlError("données après la fin de l'élément racine")
        if b == SWITCH_PAGE:
            if pos >= n:
                raise WbxmlError("document tronqué (changement de page)")
            page = data[pos]
            pos += 1
            if namespace_of(page) is None:
                raise WbxmlError(f"page de code {page} inconnue")
            continue
        if b == END:
            if not stack:
                raise WbxmlError("fin d'élément sans élément ouvert")
            finish()
            continue
        if b == STR_I:
            if not stack:
                raise WbxmlError("texte hors élément")
            end = data.find(b"\x00", pos)
            if end < 0:
                raise WbxmlError("document tronqué (texte sans terminaison)")
            if kinds[-1] == "opaque":
                raise WbxmlError(f"<{stack[-1].name}> : texte et données opaques mêlés")
            if stack[-1].children:
                raise WbxmlError(f"<{stack[-1].name}> : texte et éléments mêlés")
            nodes += 1
            if nodes > max_nodes:
                raise WbxmlError("trop d'éléments")
            kinds[-1] = "text"
            pieces[-1].append(data[pos:end])
            pos = end + 1
            continue
        if b == OPAQUE:
            if not stack:
                raise WbxmlError("données hors élément")
            length = mb_uint32()
            if length > n - pos:
                raise WbxmlError("document tronqué (données opaques)")
            if kinds[-1] is not None:
                raise WbxmlError(f"<{stack[-1].name}> : plusieurs blocs de contenu")
            if stack[-1].children:
                raise WbxmlError(f"<{stack[-1].name}> : données et éléments mêlés")
            nodes += 1
            if nodes > max_nodes:
                raise WbxmlError("trop d'éléments")
            kinds[-1] = "opaque"
            pieces[-1].append(data[pos:pos + length])
            pos += length
            continue
        if b in _REFUSED_GLOBALS:
            raise WbxmlError(f"jeton {_REFUSED_GLOBALS[b]} (0x{b:02x}) refusé")
        if b & 0x80:
            raise WbxmlError(f"attributs refusés (jeton 0x{b:02x})")
        token = b & 0x3F
        if token < 0x05:
            raise WbxmlError(f"jeton global 0x{b:02x} refusé")
        tag = tag_of(page, token)
        if tag is None:
            raise WbxmlError(f"balise inconnue 0x{token:02x} dans la page {page} ({namespace_of(page)})")
        nodes += 1
        if nodes > max_nodes:
            raise WbxmlError("trop d'éléments")
        node = Element(namespace_of(page), tag)
        if stack:
            if kinds[-1] is not None:
                raise WbxmlError(f"<{stack[-1].name}> : texte et éléments mêlés")
            stack[-1].children.append(node)
        elif root is None:
            root = node
        else:
            raise WbxmlError("plusieurs éléments racine")
        if b & 0x40:
            if len(stack) >= max_depth:
                raise WbxmlError("imbrication trop profonde")
            stack.append(node)
            pieces.append([])
            kinds.append(None)
    if stack:
        raise WbxmlError("document tronqué (élément non refermé)")
    if root is None:
        raise WbxmlError("document sans élément racine")
    return root


# ── Debug ─────────────────────────────────────────────────────────────────


def to_xml(node, *, max_value=200, indent="  "):
    """Readable XML-like form, for logs and failure messages."""
    lines = []
    stack = [(node, 0, node.ns)]
    while stack:
        n, depth, inherited = stack.pop()
        ns = n.ns or inherited
        pad = indent * depth
        if n.value is not None:
            if n.opaque:
                shown = f"[opaque {len(n.value)} octets]"
            else:
                text = n.value.decode("utf-8", "replace")
                shown = text if len(text) <= max_value else text[:max_value] + f"… [{len(n.value)} octets]"
                shown = shown.replace("\r", "\\r").replace("\n", "\\n")
            lines.append(f"{pad}<{ns}:{n.tag}>{shown}</{ns}:{n.tag}>")
        elif n.children:
            lines.append(f"{pad}<{ns}:{n.tag}>")
            stack.append((Element(ns, "/" + n.tag), depth, ns))
            for c in reversed(n.children):
                stack.append((c, depth + 1, ns))
        elif n.tag.startswith("/"):
            lines.append(f"{pad}<{ns}:{n.tag[1:]}>".replace("<", "</", 1))
        else:
            lines.append(f"{pad}<{ns}:{n.tag}/>")
    return "\n".join(lines)
